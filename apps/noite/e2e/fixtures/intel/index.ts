import type { Label } from "./util";
import { format } from "./util";

/** What the browser editor is pointed at. */
const label: Label = { count: 3, name: "noite" };

export const describe = (): string => format(label);
