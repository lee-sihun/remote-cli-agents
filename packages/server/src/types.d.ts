declare module 'qrcode-terminal' {
  interface QRCodeTerminal {
    generate(text: string, options?: { small?: boolean }, callback?: (qr: string) => void): void;
    setErrorLevel(level: string): void;
  }

  const qrcode: QRCodeTerminal;
  export default qrcode;
  export = qrcode;
}
