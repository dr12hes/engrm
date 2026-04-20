/**
 * Browser-based OAuth flow for `engrm init`.
 *
 * 1. Start a localhost HTTP server on a random port
 * 2. Open browser to candengo.com/connect/mem?redirect_uri=...
 * 3. Wait for callback with authorization code
 * 4. Return the code for exchange via /v1/mem/provision
 */

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";

const CALLBACK_TIMEOUT_MS = 600_000; // 10 minutes

export interface AuthCallbackResult {
  code: string;
  state: string;
}

/**
 * Run the browser OAuth flow.
 * Returns the authorization code to exchange for credentials.
 */
export async function runBrowserAuth(
  candengoUrl: string
): Promise<AuthCallbackResult> {
  const state = randomBytes(16).toString("hex");

  // Start callback server
  const { port, waitForCallback, stop } = await startCallbackServer(state);
  const redirectUri = `http://localhost:${port}/callback`;

  // Build authorization URL
  const authUrl = new URL("/connect/mem", candengoUrl);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);

  // Open browser
  console.log(`\nOpening browser to authorize Engrm...`);
  console.log(`If the browser doesn't open, visit:\n  ${authUrl.toString()}\n`);

  const opened = await openBrowser(authUrl.toString());
  if (!opened) {
    console.log(
      "Could not open browser. Use --token or --no-browser instead."
    );
    stop();
    throw new Error("Browser launch failed");
  }

  console.log("Waiting for authorization...");

  try {
    const result = await waitForCallback;
    return result;
  } finally {
    stop();
  }
}

/**
 * Start a localhost HTTP server that waits for the OAuth callback.
 */
async function startCallbackServer(expectedState: string): Promise<{
  port: number;
  waitForCallback: Promise<AuthCallbackResult>;
  stop: () => void;
}> {
  let resolveCallback: (result: AuthCallbackResult) => void;
  let rejectCallback: (error: Error) => void;

  const waitForCallback = new Promise<AuthCallbackResult>(
    (resolve, reject) => {
      resolveCallback = resolve;
      rejectCallback = reject;
    }
  );

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://localhost`);

    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        const desc =
          url.searchParams.get("error_description") ?? "Authorization denied";
        rejectCallback!(new Error(desc));
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(errorPage(desc));
        return;
      }

      if (!code || !state) {
        rejectCallback!(new Error("Missing code or state in callback"));
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(errorPage("Missing authorization parameters"));
        return;
      }

      if (state !== expectedState) {
        rejectCallback!(new Error("State mismatch — possible CSRF"));
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(errorPage("Security error: state mismatch"));
        return;
      }

      resolveCallback!({ code, state });
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(successPage());
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  // Listen on port 0 (OS assigns a random available port)
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  // Timeout
  const timeout = setTimeout(() => {
    rejectCallback!(
      new Error("Authorization timed out. Please try again.")
    );
  }, CALLBACK_TIMEOUT_MS);

  const stop = () => {
    clearTimeout(timeout);
    server.close();
  };

  return { port, waitForCallback, stop };
}

/**
 * Open a URL in the default browser.
 */
async function openBrowser(url: string): Promise<boolean> {
  try {
    const cmd =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "cmd"
          : "xdg-open";

    const args =
      process.platform === "win32"
        ? ["/c", "start", url]
        : [url];

    return new Promise<boolean>((resolve) => {
      execFile(cmd, args, (error) => {
        resolve(!error);
      });
    });
  } catch {
    return false;
  }
}

const PAGE_STYLE = `
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#06060e;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
body::before{content:'';position:fixed;inset:0;z-index:-1;background:radial-gradient(ellipse at 30% 20%,rgba(0,212,255,0.06) 0%,transparent 50%),radial-gradient(ellipse at 70% 80%,rgba(123,44,191,0.06) 0%,transparent 50%)}
.card{width:100%;max-width:440px;padding:48px 40px;border-radius:16px;border:1px solid rgba(255,255,255,0.07);background:rgba(255,255,255,0.02);backdrop-filter:blur(20px);text-align:center}
.logo{display:flex;align-items:center;justify-content:center;gap:12px;margin-bottom:28px}
.logo span{font-size:1.3rem;font-weight:700}
.icon{width:56px;height:56px;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 20px}
.icon.success{background:rgba(16,185,129,0.12);border:2px solid rgba(16,185,129,0.3)}
.icon.error{background:rgba(239,68,68,0.12);border:2px solid rgba(239,68,68,0.3)}
h1{font-size:1.4rem;font-weight:700;margin-bottom:8px}
p{color:rgba(255,255,255,0.6);font-size:0.9rem;line-height:1.5}
.hint{margin-top:24px;padding:12px 16px;font-size:0.82rem;color:rgba(255,255,255,0.4);background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);border-radius:8px}
a{color:#00d4ff;text-decoration:none}
`;

const LOGO_SVG = `<svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" style="width:32px;height:32px"><rect width="40" height="40" rx="10" fill="#0c0c1e"/><rect x="0.5" y="0.5" width="39" height="39" rx="9.5" stroke="rgba(255,255,255,0.08)"/><path d="M12 12h10M12 20h8M12 28h10M12 12v16" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="13" cy="7" r="3" fill="#00d4ff"/><circle cx="33" cy="33" r="3" fill="#7b2cbf"/></svg>`;

function successPage(): string {
  return `<!DOCTYPE html>
<html><head><title>Engrm — Connected</title><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect rx='6' width='32' height='32' fill='%230c0c1e'/><text x='7' y='24' font-family='system-ui' font-weight='700' font-size='22' fill='white'>E</text><circle cx='10' cy='6' r='3' fill='%2300d4ff'/><circle cx='26' cy='26' r='3' fill='%237b2cbf'/></svg>"><style>${PAGE_STYLE}</style></head>
<body><div class="card">
<div class="logo">${LOGO_SVG}<span>Engrm</span></div>
<div class="icon success"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5" stroke-linecap="round"><path d="M20 6L9 17l-5-5"/></svg></div>
<h1>Connected!</h1>
<p>Your device is now linked to your Engrm account. Memory will sync automatically across all your devices.</p>
<div class="hint">You can close this tab and return to the terminal. Your next Claude Code session will have memory.</div>
</div></body></html>`;
}

function errorPage(message: string): string {
  const safeMessage = message.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!DOCTYPE html>
<html><head><title>Engrm — Error</title><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect rx='6' width='32' height='32' fill='%230c0c1e'/><text x='7' y='24' font-family='system-ui' font-weight='700' font-size='22' fill='white'>E</text><circle cx='10' cy='6' r='3' fill='%2300d4ff'/><circle cx='26' cy='26' r='3' fill='%237b2cbf'/></svg>"><style>${PAGE_STYLE}</style></head>
<body><div class="card">
<div class="logo">${LOGO_SVG}<span>Engrm</span></div>
<div class="icon error"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.5" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg></div>
<h1>Authorization Failed</h1>
<p>${safeMessage}</p>
<div class="hint">Try running <code style="color:#00d4ff">engrm init</code> again, or use <code style="color:#00d4ff">engrm init --token=cmt_xxx</code> with a provisioning token from <a href="https://engrm.dev">engrm.dev</a>.</div>
</div></body></html>`;
}
