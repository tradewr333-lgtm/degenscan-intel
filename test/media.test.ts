import { describe, it, expect, beforeEach } from "vitest";
import { licenceRights, fromOpenverse, fromCommons, fromNasa, fromMet, wdDate, ownDates, relatedEvents, licensedImages, _media } from "../src/server/media.js";

describe("licensed_images (07/11)", () => {
  beforeEach(() => _media.reset());
  it("maps licences to permissions", () => {
    expect(licenceRights("CC0").commercial_ok).toBe(true);
    expect(licenceRights("Public domain").attribution_required).toBe(false);
    expect(licenceRights("CC BY-SA 4.0")).toMatchObject({ commercial_ok: true, derivatives_ok: true, attribution_required: true });
    expect(licenceRights("cc-by-nc")).toMatchObject({ commercial_ok: false });
    expect(licenceRights("CC BY-ND 2.0")).toMatchObject({ commercial_ok: true, derivatives_ok: false });
    expect(licenceRights("All rights reserved").commercial_ok).toBeNull();
  });
  it("normalises each source", () => {
    const o = fromOpenverse({ results: [{ url: "https://x/a.jpg", title: "A", creator: "Ann", license: "by-nc", license_version: "2.0", foreign_landing_url: "https://flickr/a", source: "flickr", attribution: "\"A\" by Ann is licensed under CC BY-NC 2.0" }] });
    expect(o[0]).toMatchObject({ commercial_ok: false, license: "CC BY-NC 2.0", source: "Openverse/flickr" });
    const c = fromCommons({ query: { pages: { 1: { title: "File:Apollo 11.jpg", imageinfo: [{ url: "https://upload/a.jpg", descriptionurl: "https://commons/a", extmetadata: { LicenseShortName: { value: "Public domain" }, Artist: { value: "<a>NASA</a>" } } }] } } } });
    expect(c[0]).toMatchObject({ title: "Apollo 11", creator: "NASA", commercial_ok: true, attribution_required: false });
    const n = fromNasa({ collection: { items: [{ data: [{ title: "Launch", nasa_id: "S69", center: "KSC", date_created: "1969-07-16T00:00:00Z" }], links: [{ href: "https://img/S69~thumb.jpg", render: "image" }] }] } });
    expect(n[0]).toMatchObject({ image_url: "https://img/S69~orig.jpg", date: "1969-07-16", commercial_ok: true });
    expect(fromMet({ isPublicDomain: false, primaryImage: "x" })).toBeNull();
    expect(fromMet({ isPublicDomain: true, primaryImage: "https://met/x.jpg", title: "Vase", objectURL: "https://met/1" })?.license).toContain("CC0");
  });
  it("interleaves sources, drops non-commercial when asked, survives a failing source", async () => {
    _media.fetch = (async (u: string) => {
      if (u.includes("openverse")) return { ok: true, json: async () => ({ results: [{ url: "https://o/1.jpg", license: "by", source: "flickr" }, { url: "https://o/2.jpg", license: "by-nc", source: "flickr" }] }) };
      if (u.includes("nasa")) return { ok: true, json: async () => ({ collection: { items: [{ data: [{ title: "N", nasa_id: "N1" }], links: [{ href: "https://n/1~thumb.jpg", render: "image" }] }] } }) };
      return { ok: false, status: 503, json: async () => ({}) };
    }) as any;
    const r: any = await licensedImages({ q: "apollo", sources: "openverse,nasa,commons" });
    expect(r.items.map((i: any) => i.image_url)).toEqual(["https://o/1.jpg", "https://n/1~orig.jpg"]);
    expect(r.sources_status.commons).toContain("unavailable"); expect(r.disclaimer).toContain("confirm the licence");
  });
});

describe("topic_timeline (07/11)", () => {
  it("parses Wikidata dates by precision", () => {
    expect(wdDate({ time: "+1913-12-23T00:00:00Z", precision: 11 })).toEqual({ date: "1913-12-23", precision: "day" });
    expect(wdDate({ time: "+1969-07-00T00:00:00Z", precision: 10 })).toEqual({ date: "1969-07", precision: "month" });
    expect(wdDate({ time: "+0800-00-00T00:00:00Z", precision: 9 })).toEqual({ date: "0800", precision: "year" });
  });
  it("extracts own dated facts and related events without duplicates", () => {
    const own = ownDates({ claims: { P571: [{ mainsnak: { datavalue: { value: { time: "+1913-12-23T00:00:00Z", precision: 11 } } } }] } });
    expect(own[0]).toMatchObject({ date: "1913-12-23", event: "inception / founded" });
    const rel = relatedEvents([{ item: { value: "http://www.wikidata.org/entity/Q1" }, itemLabel: { value: "Volcker shock" }, date: { value: "1979-10-06T00:00:00Z" }, rel: { value: "significant event" } },
      { item: { value: "http://www.wikidata.org/entity/Q1" }, itemLabel: { value: "Volcker shock" }, date: { value: "1979-10-06T00:00:00Z" } }]);
    expect(rel.length).toBe(1); expect(rel[0].wikidata).toBe("https://www.wikidata.org/wiki/Q1");
  });
});
