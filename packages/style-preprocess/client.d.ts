declare module "*.scss?pingo-style" {
  const sheet: import("@dopejs/pingo").PingoStyleSheet;
  export default sheet;
}

declare module "*.less?pingo-style" {
  const sheet: import("@dopejs/pingo").PingoStyleSheet;
  export default sheet;
}
