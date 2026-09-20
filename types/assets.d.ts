declare module "*.css";
declare module "*.svg" {
    const url: string;
    export default url;
}
declare module "*.py" {
    const source: string;
    export default source;
}
