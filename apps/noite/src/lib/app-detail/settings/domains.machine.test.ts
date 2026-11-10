import { describe, expect, test } from "bun:test";

import {
  DomainOpTypes,
  DomainsMsg,
  updateDomains,
  DomainNoticeTypes,
} from "./domains.machine";
import type { DomainsModel } from "./domains.machine";

const reload = async (): Promise<void> => {};

const model = (patch: Partial<DomainsModel> = {}): DomainsModel => ({
  appId: "app_1",
  hostname: "",
  notice: DomainNoticeTypes.None(),
  op: DomainOpTypes.Idle(),
  ...patch,
});

describe("updateDomains", () => {
  test("an empty hostname is refused without a request", () => {
    const result = updateDomains(model(), DomainsMsg.AddRequested({ reload }));

    expect(result.cmd).toBeUndefined();
    expect(result.model.notice._tag).toBe("Failed");
  });

  test("a second add while one is pending is refused", () => {
    const adding = updateDomains(
      model({ hostname: "app.example.com" }),
      DomainsMsg.AddRequested({ reload })
    );

    const second = updateDomains(
      adding.model,
      DomainsMsg.AddRequested({ reload })
    );

    expect(adding.cmd).toBeDefined();
    expect(second.cmd).toBeUndefined();
    expect(second.model).toBe(adding.model);
  });

  test("a pending claim says pending, a verified one says verified", () => {
    expect(
      updateDomains(
        model({ op: DomainOpTypes.Adding({ hostname: "x.example" }) }),
        DomainsMsg.Added({ hostname: "x.example", verified: false })
      ).model.notice
    ).toEqual(DomainNoticeTypes.Added({ verified: false }));
  });
});
