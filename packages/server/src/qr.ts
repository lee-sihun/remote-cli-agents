import type { QRPayload } from '@rca/shared';

// qrcode-terminal 타입 (동적 임포트용)
interface QRCodeTerminal {
  generate: (text: string, options: { small: boolean }, callback?: (qr: string) => void) => void;
}

// QR 코드를 터미널에 출력
export async function printQR(payload: QRPayload): Promise<void> {
  let qrterm: QRCodeTerminal;

  try {
    const mod = await import('qrcode-terminal');
    qrterm = (mod.default || mod) as QRCodeTerminal;
  } catch {
    console.log('[qr] qrcode-terminal not available, skipping QR code display');
    printSessionInfo(payload);
    return;
  }

  const json = JSON.stringify(payload);

  return new Promise<void>((resolve) => {
    qrterm.generate(json, { small: true }, (qrString: string) => {
      console.log('');
      console.log(qrString);
      console.log('');
      printSessionInfo(payload);
      resolve();
    });
  });
}

// 세션 정보 출력
function printSessionInfo(payload: QRPayload): void {
  console.log('─'.repeat(50));
  console.log(`  Session ID : ${payload.sessionId}`);
  console.log(`  Direct URL : ${payload.directUrl}`);

  if (payload.relay) {
    console.log(`  Relay      : ${payload.relay}`);
  }

  console.log(`  Token      : ${payload.token.slice(0, 8)}...`);
  console.log('─'.repeat(50));
  console.log('');
}
