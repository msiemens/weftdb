// Vite turns a CSS import into a side effect that injects the stylesheet. TypeScript only
// needs to know the module exists.
declare module "*.css" {
  const stylesheet: string;
  export default stylesheet;
}
