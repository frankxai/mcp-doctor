import { readFileSync } from "fs";
import { join } from "path";

// Read at runtime so the reported version can never drift from the published package.
export const VERSION: string = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")).version;
