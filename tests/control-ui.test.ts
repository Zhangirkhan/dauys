import { describe, expect, it } from "vitest";
import {
  wizardHtml,
  settingsHtml,
  assertWizardHtmlOrder,
} from "../apps/mac-agent/src/windows/control-ui.js";

describe("control-ui wizard HTML", () => {
  it("defines helpers before render and includes step controls", () => {
    const html = wizardHtml();
    assertWizardHtmlOrder(html);
    expect(html).toContain('id="panel"');
    expect(html).toContain("Проверить соединение");
    expect(html.indexOf("async function api")).toBeLessThan(
      html.indexOf("render();"),
    );
    expect(html).not.toContain("X-Dauys-Local");
    expect(html).not.toContain("test-token-abc");
    // Must not nest a script that calls $ before helpers
    const firstScript = html.indexOf("<script>");
    const helperPos = html.indexOf("async function api", firstScript);
    const pageRender = html.indexOf("paintSteps", helperPos);
    expect(pageRender).toBeGreaterThan(helperPos);
  });

  it("settings page also gets helpers first", () => {
    const html = settingsHtml();
    expect(html.indexOf("async function api")).toBeLessThan(
      html.indexOf("refresh()"),
    );
    expect(html).toContain("Найти приложения");
  });

  it("does not leave empty panel-only shell without buttons markup generators", () => {
    const html = wizardHtml();
    expect(html).toContain("htmlStep0");
    expect(html).toContain("hasToken");
    expect(html).toContain("ensure-connected");
    expect(html).toContain("Найдена сохранённая привязка");
  });
});
