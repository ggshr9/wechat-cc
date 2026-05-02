declare module 'qrcode-terminal' {
  interface QrCodeTerminal {
    generate(text: string, opts: { small?: boolean }, cb: (qr: string) => void): void
    generate(text: string, cb: (qr: string) => void): void
  }
  const qrt: QrCodeTerminal
  export default qrt
}
