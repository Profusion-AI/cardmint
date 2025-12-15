import { SessionRepository } from "../repositories/sessionRepository";
import { JobRepository } from "../repositories/jobRepository";
import { OperatorSession, SessionStatus, SessionPhase } from "../domain/session";
import { randomUUID } from "node:crypto";
import pino from "pino";
import fs from "node:fs";
import path from "node:path";
import { runtimeConfig } from "../config";

/**
 * SessionService orchestrates operator session lifecycle:
 * - Single active session enforcement
 * - Queue clearing on start/end
 * - Event emission for all SOP actions
 * - Heartbeat tracking and drift detection
 */
export class SessionService {
  constructor(
    private readonly sessionRepo: SessionRepository,
    private readonly jobRepo: JobRepository,
    private readonly logger: pino.Logger
  ) {}

  /**
   * Start a new operator session.
   * - Enforces single active session (409 if conflict)
   * - Clears queue (soft delete) transactionally
   * - Emits session_start and queue_cleared events
   * @param startedBy - Operator identifier
   * @param baseline - If true, starts a baseline session with relaxed Accept gates
   */
  async startSession(startedBy?: string, baseline?: boolean): Promise<OperatorSession> {
    const sessionId = randomUUID();
    const timestamp = Date.now();

    try {
      // Create session with transactional check
      const session = this.sessionRepo.create({
        id: sessionId,
        started_at: timestamp,
        status: "RUNNING",
        phase: "RUNNING",
        started_by: startedBy,
        heartbeat_at: timestamp,
        baseline: baseline ? 1 : 0,
      });

      // Emit session_start event
      this.sessionRepo.addEvent(
        sessionId,
        "session_start",
        "info",
        baseline ? `Baseline session started` : `Operator session started`,
        {
          started_by: startedBy,
          baseline: baseline ?? false,
        },
        "RUNNING"
      );

      // Clear queue (soft delete)
      const queueCount = this.jobRepo.clearQueue();
      this.logger.info({ sessionId, queueCount }, "Queue cleared during session start");

      // Emit queue_cleared event
      this.sessionRepo.addEvent(
        sessionId,
        "queue_cleared",
        "info",
        `Queue cleared (${queueCount} jobs removed)`,
        { cleared_count: queueCount },
        "RUNNING"
      );

      // Clear SFTP inbox to prevent legacy files from being re-queued
      // This fixes the race condition where watch-folder picks up old files immediately after queue clear
      let inboxFilesCleared = 0;
      let inboxTmpSkipped = 0;
      let inboxQuarantineDir: string | null = null;
      try {
        const inboxPath = runtimeConfig.sftpWatchPath;
        if (fs.existsSync(inboxPath)) {
          const quarantineRoot = path.join(path.dirname(inboxPath), "sftp-inbox-quarantine");
          inboxQuarantineDir = path.join(quarantineRoot, `session-start-${sessionId}-${timestamp}`);
          fs.mkdirSync(inboxQuarantineDir, { recursive: true });

          const files = fs.readdirSync(inboxPath);
          for (const file of files) {
            const filePath = path.join(inboxPath, file);
            if (file.endsWith(".tmp")) {
              // Avoid disrupting in-progress atomic uploads (kiosk writes *.tmp then renames).
              inboxTmpSkipped++;
              continue;
            }

            // Only quarantine regular files (skip directories + symlinks)
            const stat = fs.lstatSync(filePath);
            if (!stat.isFile()) {
              continue;
            }

            const destBase = path.join(inboxQuarantineDir, file);
            let destPath = destBase;
            if (fs.existsSync(destPath)) {
              destPath = path.join(inboxQuarantineDir, `${file}.${Date.now()}.dup`);
            }

            try {
              fs.renameSync(filePath, destPath);
            } catch (moveError: any) {
              // Cross-device fallback (rare, but safe): copy + unlink.
              if (moveError?.code === "EXDEV") {
                fs.copyFileSync(filePath, destPath);
                fs.unlinkSync(filePath);
              } else {
                throw moveError;
              }
            }
            inboxFilesCleared++;
          }
          this.logger.info(
            { sessionId, inboxPath, filesCleared: inboxFilesCleared, tmpSkipped: inboxTmpSkipped, quarantineDir: inboxQuarantineDir },
            "SFTP inbox quarantined during session start"
          );
        }
      } catch (error) {
        // Log error but don't fail session start if inbox clear fails
        this.logger.warn({ err: error, sessionId }, "Failed to clear SFTP inbox (non-blocking)");
      }

      // Emit inbox_cleared event
      if (inboxFilesCleared > 0) {
        this.sessionRepo.addEvent(
          sessionId,
          "inbox_cleared",
          "info",
          `SFTP inbox cleared (${inboxFilesCleared} files quarantined)`,
          { cleared_count: inboxFilesCleared, tmp_skipped: inboxTmpSkipped, quarantine_dir: inboxQuarantineDir },
          "RUNNING"
        );
      }

      this.logger.info({ sessionId }, "Session started successfully");
      return session;
    } catch (error) {
      if (error instanceof Error && error.message.includes("409")) {
        this.logger.warn({ sessionId }, "Session start conflict: another session already active");
        throw new Error("Another session is already active (409 Conflict)");
      }
      this.logger.error({ err: error, sessionId }, "Failed to start session");
      throw error;
    }
  }

  /**
   * End an active operator session.
   * - Transitions to VALIDATING then CLOSED
   * - Clears queue again
   * - Emits session_end and queue_cleared events
   */
  async endSession(sessionId: string): Promise<OperatorSession> {
    const session = this.sessionRepo.getById(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    if (session.status === "CLOSED" || session.status === "ABORTED") {
      throw new Error(`Cannot end session in ${session.status} state`);
    }

    // Transition to VALIDATING
    this.sessionRepo.updateStatus(sessionId, "VALIDATING", "VALIDATING");

    // Emit session_end event
    this.sessionRepo.addEvent(sessionId, "session_end", "info", `Session ending`, {}, "VALIDATING");

    // Clear queue one more time
    const queueCount = this.jobRepo.clearQueue();
    this.logger.info({ sessionId, queueCount }, "Queue cleared during session end");

    this.sessionRepo.addEvent(
      sessionId,
      "queue_cleared",
      "info",
      `Queue cleared (${queueCount} jobs removed)`,
      { cleared_count: queueCount },
      "VALIDATING"
    );

    // Transition to CLOSED
    this.sessionRepo.close(sessionId, "CLOSED");
    this.sessionRepo.updateStatus(sessionId, "CLOSED", "CLOSED");

    this.logger.info({ sessionId }, "Session ended successfully");
    return this.sessionRepo.getById(sessionId)!;
  }

  /**
   * Abort an active session (operator/system emergency stop).
   */
  async abortSession(sessionId: string, reason?: string): Promise<OperatorSession> {
    const session = this.sessionRepo.getById(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Emit abort event before closing
    this.sessionRepo.addEvent(
      sessionId,
      "session_abort",
      "warning",
      `Session aborted: ${reason ?? "no reason provided"}`,
      { reason },
      session.phase
    );

    // Close with ABORTED status
    this.sessionRepo.close(sessionId, "ABORTED");

    this.logger.warn({ sessionId, reason }, "Session aborted");
    return this.sessionRepo.getById(sessionId)!;
  }

  /**
   * Get the currently active session.
   */
  getActiveSession(): OperatorSession | undefined {
    return this.sessionRepo.getActive();
  }

  /**
   * Update heartbeat for a session (called periodically by frontend).
   */
  updateHeartbeat(sessionId: string): void {
    const session = this.sessionRepo.getById(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    this.sessionRepo.updateHeartbeat(sessionId);
  }

  /**
   * Emit a structured event for a session.
   * Skips if no active session and level !== 'error' (noise prevention).
   */
  async emitEvent(
    source: string,
    level: "info" | "warning" | "error" = "info",
    message?: string,
    payload?: Record<string, any>
  ): Promise<void> {
    const activeSession = this.sessionRepo.getActive();

    // Skip low-level events outside of active session
    if (!activeSession && level !== "error") {
      return;
    }

    if (activeSession) {
      this.sessionRepo.addEvent(
        activeSession.id,
        source,
        level,
        message,
        payload,
        activeSession.phase
      );
      this.logger.debug({ sessionId: activeSession.id, source, level }, "Event emitted");
    }
  }

  /**
   * Get events for a session since a given timestamp (for polling).
   */
  getEventsSince(sessionId: string, sinceTimestamp?: number) {
    return this.sessionRepo.getEventsSince(sessionId, sinceTimestamp);
  }

  /**
   * Get all events for a session (newest first).
   */
  getAllEvents(sessionId: string) {
    return this.sessionRepo.getAllEvents(sessionId);
  }

  /**
   * Update PPT quota state for the active session.
   * Used by Path C to reflect credits spent in the operator UI.
   */
  updateQuota(quota: {
    tier: string;
    dailyLimit: number;
    dailyRemaining: number | null;
    callsConsumed: number | null;
    warningLevel: "ok" | "warning" | "critical";
  }): void {
    const activeSession = this.sessionRepo.getActive();
    if (!activeSession) {
      this.logger.debug({ quota }, "No active session, skipping quota update");
      return;
    }

    this.sessionRepo.updateQuota(activeSession.id, quota);
    this.logger.debug(
      { sessionId: activeSession.id, dailyRemaining: quota.dailyRemaining, warningLevel: quota.warningLevel },
      "Session quota updated"
    );
  }
}
