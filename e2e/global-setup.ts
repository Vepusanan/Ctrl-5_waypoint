// Waits for the seeded stack to answer before any real-stack spec signs in. Without it a spec
// that starts while the API is still booting fails on its first login, far from the cause.
export default async function globalSetup(): Promise<void> {
  const base = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
  const deadline = Date.now() + 60_000;
  let last = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (cause) {
      last = cause instanceof Error ? cause.message : String(cause);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`The stack at ${base} did not become healthy within 60 s (${last})`);
}
