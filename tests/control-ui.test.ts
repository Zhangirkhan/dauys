import { describe, expect, it } from "vitest";
import {
  wizardHtml,
  settingsHtml,
  assertWizardHtmlOrder,
} from "../apps/mac-agent/src/windows/control-ui.js";

describe("control-ui wizard HTML", () => {
  it("defines helpers before render and includes step controls", () => {
    const html = wizardHtml("test-token-abc");
    assertWizardHtmlOrder(html);
    expect(html).toContain('id="panel"');
    expect(html).toContain("Проверить соединение");
    expect(html).toContain("var TOKEN");
    expect(html.indexOf("var TOKEN")).toBeLessThan(html.indexOf("render();"));
    expect(html).toContain("X-Dauys-Local");
    expect(html).toContain("test-token-abc");
    // Must not nest a script that calls $ before helpers
    const firstScript = html.indexOf("<script>");
    const helperPos = html.indexOf("var TOKEN", firstScript);
    const pageRender = html.indexOf("paintSteps", helperPos);
    expect(pageRender).toBeGreaterThan(helperPos);
  });

  it("settings page also gets helpers first", () => {
    const html = settingsHtml("tok");
    expect(html.indexOf("var TOKEN")).toBeLessThan(html.indexOf("refresh()"));
    expect(html).toContain("Найти приложения");
  });

  it("does not leave empty panel-only shell without buttons markup generators", () => {
    const html = wizardHtml("t");
    expect(html).toContain("htmlStep0");
    expect(html).toContain("hasToken");
    expect(html).toContain("ensure-connected");
    expect(html).toContain("Найдена сохранённая привязка");
  });
});
