import { z } from 'zod';

/**
 * Shared input schemas for CardMint input-bus system
 * Used by both server (API/telemetry) and client (dashboard)
 * Ensures consistent validation across the entire input pipeline
 */

// Base action types - minimal set for operator console
export const InputActionSchema = z.enum(['capture', 'approve', 'reject']);
export type InputAction = z.infer<typeof InputActionSchema>;

// Input sources for A/B testing
export const InputSourceSchema = z.enum(['keyboard', 'controller']);
export type InputSource = z.infer<typeof InputSourceSchema>;

// Core input event structure
export const InputEventSchema = z.object({
  action: InputActionSchema,
  source: InputSourceSchema,
  ts: z.number(),
  seq: z.number().optional(), // Set by input bus
  cardId: z.string().optional(),
  cycleId: z.string().optional(),
});
export type InputEvent = z.infer<typeof InputEventSchema>;

// Telemetry event for CSV logging and A/B analysis
export const TelemetryEventSchema = z.object({
  ts: z.number(),
  source: InputSourceSchema,
  action: InputActionSchema,
  cardId: z.string().default(''),
  cycleId: z.string(),
  latencyMs: z.number(),
  error: z.string().default(''),
});
export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;

// Telemetry summary for dashboard display
export const TelemetrySummarySchema = z.object({
  totalInputs: z.number(),
  keyboardInputs: z.number(),
  controllerInputs: z.number(),
  avgLatencyMs: z.number(),
  sessionDurationMs: z.number(),
  throughputPerMinute: z.number(),
  cycleId: z.string().optional(),
});
export type TelemetrySummary = z.infer<typeof TelemetrySummarySchema>;

// Validation functions for runtime use
export const validateInputEvent = (event: unknown): InputEvent => {
  return InputEventSchema.parse(event);
};

export const validateTelemetryEvent = (event: unknown): TelemetryEvent => {
  return TelemetryEventSchema.parse(event);
};

// Constants for reference
export const VALID_ACTIONS: readonly InputAction[] = ['capture', 'approve', 'reject'] as const;
export const VALID_SOURCES: readonly InputSource[] = ['keyboard', 'controller'] as const;

// CSV header for telemetry logging
export const TELEMETRY_CSV_HEADER = 'ts,source,action,cardId,cycleId,latencyMs,error';

// Type guards for runtime checking
export const isValidAction = (action: string): action is InputAction => {
  return VALID_ACTIONS.includes(action as InputAction);
};

export const isValidSource = (source: string): source is InputSource => {
  return VALID_SOURCES.includes(source as InputSource);
};