// Durable Object identity: hex ids (named or unique), mirroring the
// Cloudflare `DurableObjectId` API (`toString`, `equals`, no wire access).
export class DurableObjectId {
  readonly id: string;
  readonly name: string | undefined;

  constructor(id: string, name?: string) {
    this.id = id;
    this.name = name;
  }

  toString(): string {
    return this.id;
  }

  equals(other: DurableObjectId): boolean {
    return other instanceof DurableObjectId && other.id === this.id;
  }
}
