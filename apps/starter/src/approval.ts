export interface ApprovalRequest {
  readLine: () => Promise<string | null>;
  timeoutMs: number;
}

export async function requestLocalApproval(request: ApprovalRequest): Promise<boolean> {
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0) return false;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const input = await Promise.race([
      request.readLine(),
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), request.timeoutMs);
      }),
    ]);
    return input?.trim().toLowerCase() === 'y';
  } catch {
    return false;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
