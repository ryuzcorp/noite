/** A label the entry module formats. */
export interface Label {
  count: number;
  name: string;
}

/** `<name>: <count>`, the only formatting this repo does. */
export const format = (label: Label): string => `${label.name}: ${label.count}`;
