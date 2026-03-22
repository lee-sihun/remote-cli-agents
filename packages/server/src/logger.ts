// RCA_DEBUG=1 환경변수로 디버그 로그 활성화
const isDebug = process.env.RCA_DEBUG === '1' || process.env.RCA_DEBUG === 'true';

export function debugLog(...args: unknown[]): void {
  if (isDebug) {
    console.log(...args);
  }
}

export function debugError(...args: unknown[]): void {
  if (isDebug) {
    console.error(...args);
  }
}
