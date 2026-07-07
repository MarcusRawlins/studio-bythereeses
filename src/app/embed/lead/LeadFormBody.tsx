// Phase 19 — the embed form body. A PURE presentational component (no next/* imports) so it can be
// rendered to static markup in tests (§9 tests 12/14) and so its output is trivially auditable.
//
// MEDIUM-3 (config stored-XSS): EVERY config string (introText, submitButtonText) is rendered as an
// ESCAPED JSX TEXT NODE. There is NO dangerouslySetInnerHTML anywhere in this file. React escaping
// is the load-bearing guarantee — a `<script>` in introText renders as inert text. `white-space:
// pre-wrap` preserves author line breaks WITHOUT injecting HTML.

import {
  LEAD_FORM_FIELD_LABELS,
  OPTIONAL_LEAD_FORM_FIELDS,
  type LeadFormConfig,
} from "@/lib/lead-form";

// Generic, PII-free copy for each redirect error code. The redirect URL only ever carries
// `?t=<token>&error=<code>` (never submitted name/email/message — those would land in proxy logs).
const ERROR_MESSAGES: Record<string, string> = {
  name: "Please enter your name.",
  email: "Please enter a valid email address.",
  message: "Please enter a message.",
  missing: "Please complete the required fields.",
  expired: "This form was open a while — please review your details and resubmit.",
  session: "Something went wrong with this form session — please resubmit.",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  marginBottom: "14px",
  fontSize: "13px",
  fontWeight: 600,
  color: "#3a352e",
};

const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  boxSizing: "border-box",
  marginTop: "6px",
  padding: "10px 12px",
  fontSize: "14px",
  fontWeight: 400,
  border: "1px solid #d5d0c8",
  borderRadius: "6px",
  background: "#ffffff",
  color: "#222",
};

export function LeadFormBody({
  config,
  token,
  nonceToken,
  error,
}: {
  config: LeadFormConfig;
  token: string;
  nonceToken: string;
  error?: string | null;
}) {
  const errorMessage = error ? ERROR_MESSAGES[error] ?? ERROR_MESSAGES.missing : null;

  return (
    <main style={{ margin: 0, padding: "20px", background: "#f8f6f3", color: "#222", fontFamily: "Arial, sans-serif" }}>
      <form
        action="/api/lead-form/submit"
        method="post"
        style={{ width: "min(560px, 100%)", margin: "0 auto" }}
      >
        {/* The signed embed token + the per-render timing nonce ride as hidden fields. */}
        <input type="hidden" name="t" value={token} />
        <input type="hidden" name="formNonce" value={nonceToken} />

        {/* Honeypot: humans never see it; bots fill every field. Off-screen, untabbable, no autofill. */}
        <div aria-hidden="true" style={{ position: "absolute", left: "-9999px", top: "-9999px", height: 0, width: 0, overflow: "hidden" }}>
          <label>
            Company website
            <input type="text" name="company_website" tabIndex={-1} autoComplete="off" />
          </label>
        </div>

        {config.introText ? (
          <p style={{ whiteSpace: "pre-wrap", margin: "0 0 20px", color: "#6f665b", lineHeight: 1.6, fontSize: "14px" }}>
            {config.introText}
          </p>
        ) : null}

        {errorMessage ? (
          <p role="alert" style={{ margin: "0 0 18px", padding: "10px 12px", border: "1px solid #c9a99a", background: "#fbf0ec", color: "#8a3b26", borderRadius: "6px", fontSize: "13px" }}>
            {errorMessage}
          </p>
        ) : null}

        <label style={labelStyle}>
          {LEAD_FORM_FIELD_LABELS.name} *
          <input name="name" required maxLength={200} style={inputStyle} />
        </label>

        <label style={labelStyle}>
          {LEAD_FORM_FIELD_LABELS.email} *
          <input name="email" type="email" required maxLength={320} style={inputStyle} />
        </label>

        {OPTIONAL_LEAD_FORM_FIELDS.map((field) => {
          const fieldConfig = config.fields[field];
          if (!fieldConfig.enabled) return null;
          const isDate = field === "eventDate";
          return (
            <label key={field} style={labelStyle}>
              {LEAD_FORM_FIELD_LABELS[field]}
              {fieldConfig.required ? " *" : ""}
              <input
                name={field}
                type={isDate ? "date" : "text"}
                required={fieldConfig.required}
                maxLength={isDate ? undefined : 320}
                style={inputStyle}
              />
            </label>
          );
        })}

        <label style={labelStyle}>
          {LEAD_FORM_FIELD_LABELS.message} *
          <textarea name="message" required rows={5} maxLength={50000} style={{ ...inputStyle, resize: "vertical" }} />
        </label>

        <button
          type="submit"
          style={{ display: "block", width: "100%", marginTop: "6px", padding: "12px 16px", fontSize: "13px", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#f8f6f3", background: "#222", border: "1px solid #222", borderRadius: "6px", cursor: "pointer" }}
        >
          {config.submitButtonText}
        </button>
      </form>
    </main>
  );
}
