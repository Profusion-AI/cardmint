/**
 * Resend Transactional Email Service
 *
 * Wraps the Resend API for sending transactional emails.
 * Used by EmailOutboxWorker to deliver order confirmation + tracking emails.
 *
 * Design principles:
 * - Simple API: single sendEmail method
 * - HTML + text fallback for accessibility
 * - Tags for Resend dashboard filtering
 * - No PII stored: recipient email passed at send time
 *
 * Reference: PR2 Email Outbox plan
 * @see https://resend.com/docs
 */

import type { Logger } from "pino";
import { runtimeConfig } from "../config.js";
import type { OrderConfirmationData, OrderConfirmedTrackingData } from "../repositories/emailOutboxRepository.js";

/**
 * Template data for claim order email (P1.3)
 */
export interface ClaimEmailData {
  orderNumber: string;
  claimUrl: string;
  expiresInMinutes: number;
}

// Resend types (we don't import the SDK directly to allow for mocking)
interface ResendEmailResponse {
  id?: string;
  error?: {
    message: string;
    name: string;
  };
}

export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  text?: string;
  tags?: Array<{ name: string; value: string }>;
}

export interface SendEmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export class ResendService {
  private apiKey: string;
  private fromEmail: string;
  private fromName: string;
  private logger: Logger;

  constructor(logger: Logger) {
    this.apiKey = runtimeConfig.resendApiKey;
    this.fromEmail = runtimeConfig.resendFromEmail;
    this.fromName = runtimeConfig.resendFromName;
    this.logger = logger.child({ service: "resend" });

    if (this.isConfigured()) {
      this.logger.info("Resend email service initialized");
    } else {
      this.logger.warn("Resend API key not configured - transactional email features disabled");
    }
  }

  /**
   * Check if Resend is configured and ready
   */
  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  /**
   * Send an email via Resend API
   */
  async sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
    if (!this.isConfigured()) {
      return { success: false, error: "Resend not configured (RESEND_API_KEY missing)" };
    }

    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: this.fromEmail,
          to: params.to,
          subject: params.subject,
          html: params.html,
          text: params.text,
          tags: params.tags,
        }),
      });

      const data = (await response.json()) as ResendEmailResponse;

      if (!response.ok || data.error) {
        const errorMsg = data.error?.message || `HTTP ${response.status}`;
        this.logger.error({ err: errorMsg, status: response.status }, "Resend API error");
        return { success: false, error: errorMsg };
      }

      this.logger.info({ messageId: data.id }, "Email sent successfully");
      return { success: true, messageId: data.id };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error({ err }, "Resend request failed");
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Build simple order confirmation email (sent at checkout)
   * No tracking info - just acknowledges the order was received
   */
  buildSimpleOrderConfirmationEmail(data: OrderConfirmationData): {
    subject: string;
    html: string;
    text: string;
  } {
    const formatCents = (cents: number) => `$${(cents / 100).toFixed(2)}`;

    const subject = `Thank you for your CardMint order ${data.orderNumber}`;

    const itemsHtml = data.items
      .map(
        (item) => `
      <tr>
        <td style="padding: 12px 0; border-bottom: 1px solid #eee;">
          ${
            item.imageUrl
              ? `<img src="${escapeHtml(item.imageUrl)}" alt="" style="width: 60px; height: auto; border-radius: 4px; margin-right: 12px; vertical-align: middle;">`
              : ""
          }
          <span style="font-weight: 500;">${escapeHtml(item.name)}</span>
        </td>
        <td style="padding: 12px 0; border-bottom: 1px solid #eee; text-align: right;">
          ${formatCents(item.priceCents)}
        </td>
      </tr>
    `
      )
      .join("");

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f5f5f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f5; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
          <!-- Header -->
          <tr>
            <td style="background-color: #1a1a2e; padding: 24px 32px; text-align: center;">
              <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600;">CardMint</h1>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 32px;">
              <h2 style="margin: 0 0 8px; color: #1a1a2e; font-size: 20px;">Thank you for your order!</h2>
              <p style="margin: 0 0 24px; color: #666; font-size: 14px;">Order ${escapeHtml(data.orderNumber)}</p>

              <p style="margin: 0 0 24px; color: #444; font-size: 14px; line-height: 1.6;">
                We've received your order and will email you again with tracking information once your package ships.
              </p>

              <!-- Order Items -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 24px;">
                <thead>
                  <tr>
                    <td style="padding: 8px 0; border-bottom: 2px solid #1a1a2e; font-weight: 600; color: #1a1a2e;">Item</td>
                    <td style="padding: 8px 0; border-bottom: 2px solid #1a1a2e; font-weight: 600; color: #1a1a2e; text-align: right;">Price</td>
                  </tr>
                </thead>
                <tbody>
                  ${itemsHtml}
                </tbody>
              </table>

              <!-- Totals -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding: 4px 0; color: #666;">Subtotal</td>
                  <td style="padding: 4px 0; text-align: right;">${formatCents(data.subtotalCents)}</td>
                </tr>
                <tr>
                  <td style="padding: 4px 0; color: #666;">Shipping</td>
                  <td style="padding: 4px 0; text-align: right;">${formatCents(data.shippingCents)}</td>
                </tr>
                <tr>
                  <td style="padding: 12px 0 0; font-weight: 600; font-size: 16px; border-top: 1px solid #eee;">Total</td>
                  <td style="padding: 12px 0 0; font-weight: 600; font-size: 16px; border-top: 1px solid #eee; text-align: right;">${formatCents(data.totalCents)}</td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #f8f9fa; padding: 24px 32px; text-align: center; border-top: 1px solid #eee;">
              <p style="margin: 0 0 8px; color: #888; font-size: 12px;">Questions about your order? Contact us at:</p>
              <a href="mailto:support@cardmintshop.com" style="color: #1a1a2e; font-size: 14px;">support@cardmintshop.com</a>
              <p style="margin: 16px 0 0; color: #888; font-size: 11px;">This is an automated message from noreply@cardmintshop.com</p>
              <p style="margin: 4px 0 0; color: #ccc; font-size: 11px;">CardMint</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    const itemsText = data.items.map((item) => `  - ${item.name}: ${formatCents(item.priceCents)}`).join("\n");

    const text = `
Thank You for Your CardMint Order!

Order: ${data.orderNumber}

We've received your order and will email you again with tracking information once your package ships.

Items:
${itemsText}

Subtotal: ${formatCents(data.subtotalCents)}
Shipping: ${formatCents(data.shippingCents)}
Total: ${formatCents(data.totalCents)}

Questions about your order? Contact us at support@cardmintshop.com

This is an automated message from noreply@cardmintshop.com
CardMint
`;

    return { subject, html, text };
  }

  /**
   * Build order confirmation + tracking email (sent after label purchase)
   * Combined template for shipment notification with tracking
   */
  buildOrderConfirmationEmail(data: OrderConfirmedTrackingData): {
    subject: string;
    html: string;
    text: string;
  } {
    const formatCents = (cents: number) => `$${(cents / 100).toFixed(2)}`;

    const subject = `Your CardMint order ${data.orderNumber} has shipped!`;

    const itemsHtml = data.items
      .map(
        (item) => `
      <tr>
        <td style="padding: 12px 0; border-bottom: 1px solid #eee;">
          ${
            item.imageUrl
              ? `<img src="${escapeHtml(item.imageUrl)}" alt="" style="width: 60px; height: auto; border-radius: 4px; margin-right: 12px; vertical-align: middle;">`
              : ""
          }
          <span style="font-weight: 500;">${escapeHtml(item.name)}</span>
        </td>
        <td style="padding: 12px 0; border-bottom: 1px solid #eee; text-align: right;">
          ${formatCents(item.priceCents)}
        </td>
      </tr>
    `
      )
      .join("");

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f5f5f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f5; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
          <!-- Header -->
          <tr>
            <td style="background-color: #1a1a2e; padding: 24px 32px; text-align: center;">
              <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600;">CardMint</h1>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 32px;">
              <h2 style="margin: 0 0 8px; color: #1a1a2e; font-size: 20px;">Your order is on its way!</h2>
              <p style="margin: 0 0 24px; color: #666; font-size: 14px;">Order ${escapeHtml(data.orderNumber)}</p>

              <!-- Tracking Box -->
              <div style="background-color: #f8f9fa; border-radius: 8px; padding: 20px; margin-bottom: 24px; text-align: center;">
                <p style="margin: 0 0 8px; color: #666; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px;">${escapeHtml(data.carrier)} Tracking</p>
                <a href="${escapeHtml(data.trackingUrl)}" style="display: inline-block; font-size: 18px; font-weight: 600; color: #1a1a2e; text-decoration: none; background-color: #e8f4fd; padding: 12px 24px; border-radius: 6px;">
                  ${escapeHtml(data.trackingNumber)}
                </a>
                <p style="margin: 12px 0 0; color: #888; font-size: 12px;">Click to track your package</p>
              </div>

              <!-- Order Items -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 24px;">
                <thead>
                  <tr>
                    <td style="padding: 8px 0; border-bottom: 2px solid #1a1a2e; font-weight: 600; color: #1a1a2e;">Item</td>
                    <td style="padding: 8px 0; border-bottom: 2px solid #1a1a2e; font-weight: 600; color: #1a1a2e; text-align: right;">Price</td>
                  </tr>
                </thead>
                <tbody>
                  ${itemsHtml}
                </tbody>
              </table>

              <!-- Totals -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding: 4px 0; color: #666;">Subtotal</td>
                  <td style="padding: 4px 0; text-align: right;">${formatCents(data.subtotalCents)}</td>
                </tr>
                <tr>
                  <td style="padding: 4px 0; color: #666;">Shipping</td>
                  <td style="padding: 4px 0; text-align: right;">${formatCents(data.shippingCents)}</td>
                </tr>
                <tr>
                  <td style="padding: 12px 0 0; font-weight: 600; font-size: 16px; border-top: 1px solid #eee;">Total</td>
                  <td style="padding: 12px 0 0; font-weight: 600; font-size: 16px; border-top: 1px solid #eee; text-align: right;">${formatCents(data.totalCents)}</td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #f8f9fa; padding: 24px 32px; text-align: center; border-top: 1px solid #eee;">
              <p style="margin: 0 0 8px; color: #888; font-size: 12px;">Questions about your order? Contact us at:</p>
              <a href="mailto:support@cardmintshop.com" style="color: #1a1a2e; font-size: 14px;">support@cardmintshop.com</a>
              <p style="margin: 16px 0 0; color: #888; font-size: 11px;">This is an automated message from noreply@cardmintshop.com</p>
              <p style="margin: 4px 0 0; color: #ccc; font-size: 11px;">CardMint</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    const itemsText = data.items.map((item) => `  - ${item.name}: ${formatCents(item.priceCents)}`).join("\n");

    const text = `
Your CardMint Order Has Shipped!

Order: ${data.orderNumber}

Track your package:
${data.carrier}: ${data.trackingNumber}
${data.trackingUrl}

Items:
${itemsText}

Subtotal: ${formatCents(data.subtotalCents)}
Shipping: ${formatCents(data.shippingCents)}
Total: ${formatCents(data.totalCents)}

Questions about your order? Contact us at support@cardmintshop.com

This is an automated message from noreply@cardmintshop.com
CardMint
`;

    return { subject, html, text };
  }

  /**
   * Build claim order email (P1.3)
   * Sent when customer requests to claim an order to their account.
   */
  buildClaimEmail(data: ClaimEmailData): {
    subject: string;
    html: string;
    text: string;
  } {
    const subject = `Claim your CardMint order ${data.orderNumber}`;

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f5f5f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f5; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
          <!-- Header -->
          <tr>
            <td style="background-color: #1a1a2e; padding: 24px 32px; text-align: center;">
              <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600;">CardMint</h1>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 32px;">
              <h2 style="margin: 0 0 8px; color: #1a1a2e; font-size: 20px;">Claim Your Order</h2>
              <p style="margin: 0 0 24px; color: #666; font-size: 14px;">Order ${escapeHtml(data.orderNumber)}</p>

              <p style="margin: 0 0 24px; color: #444; font-size: 14px; line-height: 1.6;">
                Click the button below to claim this order to your CardMint account. This link will expire in ${data.expiresInMinutes} minutes.
              </p>

              <!-- CTA Button -->
              <div style="text-align: center; margin: 32px 0;">
                <a href="${escapeHtml(data.claimUrl)}" style="display: inline-block; background-color: #1a1a2e; color: #ffffff; font-size: 16px; font-weight: 600; text-decoration: none; padding: 16px 48px; border-radius: 8px;">
                  Claim Order
                </a>
              </div>

              <p style="margin: 24px 0 0; color: #888; font-size: 12px; line-height: 1.6;">
                If you didn't request this email, you can safely ignore it. This link can only be used once and will expire automatically.
              </p>

              <p style="margin: 16px 0 0; color: #aaa; font-size: 11px; line-height: 1.4; word-break: break-all;">
                Or copy this link: ${escapeHtml(data.claimUrl)}
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #f8f9fa; padding: 24px 32px; text-align: center; border-top: 1px solid #eee;">
              <p style="margin: 0 0 8px; color: #888; font-size: 12px;">Questions? Contact us at:</p>
              <a href="mailto:support@cardmintshop.com" style="color: #1a1a2e; font-size: 14px;">support@cardmintshop.com</a>
              <p style="margin: 16px 0 0; color: #888; font-size: 11px;">This is an automated message from noreply@cardmintshop.com</p>
              <p style="margin: 4px 0 0; color: #ccc; font-size: 11px;">CardMint</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    const text = `
Claim Your CardMint Order

Order: ${data.orderNumber}

Click the link below to claim this order to your CardMint account.
This link will expire in ${data.expiresInMinutes} minutes.

${data.claimUrl}

If you didn't request this email, you can safely ignore it.
This link can only be used once and will expire automatically.

Questions? Contact us at support@cardmintshop.com

This is an automated message from noreply@cardmintshop.com
CardMint
`;

    return { subject, html, text };
  }
}

/**
 * Escape HTML special characters to prevent XSS
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Factory function to create ResendService instance
 */
export function createResendService(logger: Logger): ResendService {
  return new ResendService(logger);
}
