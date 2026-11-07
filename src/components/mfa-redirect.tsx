"use client";
import * as React from "react";
import { MFA_ENROLL_PATH } from "@/lib/mfa-policy";

/**
 * Rendered by the /app and /admin layouts instead of the page when the user must enrol MFA first.
 * It performs a FULL-document navigation, never a client (RSC) redirect: Next.js reuses layout segments across
 * soft navigations, so a layout-level redirect() kept being replayed on the enrolment page itself and looped
 * (~80 RSC requests/s, blank page — production incident 2026-11-07). A full load always re-renders the layout
 * with the correct path, so this terminates on the enrolment page.
 */
export function MfaRedirect() {
  const target = `${MFA_ENROLL_PATH}?mfa=required`;
  React.useEffect(() => { window.location.replace(target); }, [target]);
  return (
    <main className="flex min-h-screen items-center justify-center p-6" data-testid="mfa-redirect">
      <p className="max-w-sm text-center text-sm text-ink-2">
        Two-factor authentication is required for this account. Opening{" "}
        <a className="font-semibold text-royal underline" href={target}>Security settings</a>…
      </p>
    </main>
  );
}
