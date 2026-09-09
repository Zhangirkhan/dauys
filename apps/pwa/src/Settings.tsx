import { useState } from "react";
import {
  ArrowLeft,
  Plus,
  Trash2,
  Save,
  Smartphone,
  Laptop,
} from "lucide-react";
import type { Registry } from "@voice/shared";
import { api } from "./api";
export type Device = {
  id: string;
  name: string;
  role: "client" | "agent";
  online: boolean;
  revoked: number;
  platform?: "darwin" | "win32" | "linux" | null;
};
export function Settings({
  registry,
  devices,
  onBack,
  onSave,
  onRevoke,
}: {
  registry: Registry;
  devices: Device[];
  onBack: () => void;
  onSave: (r: Registry) => void;
  onRevoke: (id: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Registry>(structuredClone(registry)),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false),
    [saved, setSaved] = useState(false);
  const changeProject = (index: number, key: string, value: unknown) => {
    setSaved(false);
    setDraft((d) => ({
      ...d,
      projects: d.projects.map((p, i) =>
        i === index ? { ...p, [key]: value } : p,
      ),
    }));
  };
  async function save() {
    setSaving(true);
    setError("");
    try {
      const r = await api<Registry>("/api/config", {
        method: "PUT",
        body: JSON.stringify(draft),
      });
      onSave(r);
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <main className="settings">
      <header className="page-heading">
        <button className="icon-button" onClick={onBack} aria-label="Назад">
          <ArrowLeft />
        </button>
        <h1>Ваше пространство</h1>
      </header>
      <p className="muted">Проекты, приложения и подключённые устройства.</p>
      <h2>
        Проекты{" "}
        <button
          className="small-button"
          onClick={() =>
            setDraft((d) => ({
              ...d,
              projects: [
                ...d.projects,
                {
                  id: "project-" + Date.now(),
                  name: "Новый проект",
                  description: "Мой проект",
                  aliases: [],
                  path: "/Users/USERNAME/Projects/project",
                  defaultApplication: d.applications[0]?.name ?? "Cursor",
                  urls: {},
                  scenarios: {},
                },
              ],
            }))
          }
        >
          <Plus size={15} /> Добавить
        </button>
      </h2>
      {draft.projects.map((p, i) => (
        <section className="edit-card" key={p.id}>
          <div className="row">
            <strong>{p.name}</strong>
            <button
              className="icon-button danger"
              aria-label={"Удалить проект " + p.name}
              onClick={() =>
                setDraft((d) => ({
                  ...d,
                  projects: d.projects.filter((_, j) => j !== i),
                }))
              }
            >
              <Trash2 size={17} />
            </button>
          </div>
          <small className="muted">ID: {p.id}</small>
          <label>
            Название
            <input
              value={p.name}
              onChange={(e) => changeProject(i, "name", e.target.value)}
            />
          </label>
          <label>
            Описание
            <textarea
              value={p.description}
              onChange={(e) => changeProject(i, "description", e.target.value)}
            />
          </label>
          <label>
            Псевдонимы через запятую
            <input
              value={p.aliases.join(", ")}
              onChange={(e) =>
                changeProject(
                  i,
                  "aliases",
                  e.target.value.split(",").map((s) => s.trim()),
                )
              }
            />
          </label>
          <label>
            Путь на компьютере
            <input
              value={p.path}
              onChange={(e) => changeProject(i, "path", e.target.value)}
            />
          </label>
          <label>
            Открывать в
            <select
              value={p.defaultApplication}
              onChange={(e) =>
                changeProject(i, "defaultApplication", e.target.value)
              }
            >
              {draft.applications.map((a) => (
                <option key={a.id}>{a.name}</option>
              ))}
            </select>
          </label>
          {[
            "production",
            "local",
            ...Object.keys(p.urls).filter(
              (k) => !["production", "local"].includes(k),
            ),
          ].map((k) => (
            <label key={k}>
              {k === "production"
                ? "Сайт"
                : k === "local"
                  ? "Локальный URL"
                  : k}
              <input
                type="url"
                value={p.urls[k] ?? ""}
                placeholder="https://example.com"
                onChange={(e) => {
                  const urls = { ...p.urls };
                  if (e.target.value) urls[k] = e.target.value;
                  else delete urls[k];
                  changeProject(i, "urls", urls);
                }}
              />
            </label>
          ))}
          <details>
            <summary>Сценарии</summary>
            <p className="muted">
              Шаги из белого списка. Команды запуска настраиваются только
              локально на компьютере.
            </p>
            <textarea
              aria-label={"Сценарии " + p.name}
              className="code-input"
              defaultValue={JSON.stringify(p.scenarios, null, 2)}
              onBlur={(e) => {
                try {
                  changeProject(i, "scenarios", JSON.parse(e.target.value));
                  setError("");
                } catch {
                  setError("Некорректный JSON сценария");
                }
              }}
            />
          </details>
        </section>
      ))}
      <h2>
        Приложения{" "}
        <button
          className="small-button"
          onClick={() =>
            setDraft((d) => ({
              ...d,
              applications: [
                ...d.applications,
                {
                  id: "app-" + Date.now(),
                  name: "Новое приложение",
                  aliases: [],
                },
              ],
            }))
          }
        >
          <Plus size={15} /> Добавить
        </button>
      </h2>
      {draft.applications.map((a, i) => (
        <section className="edit-card" key={a.id}>
          <div className="row">
            <strong>{a.name}</strong>
            <button
              className="icon-button danger"
              aria-label={"Удалить " + a.name}
              onClick={() =>
                setDraft((d) => ({
                  ...d,
                  applications: d.applications.filter((_, j) => j !== i),
                }))
              }
            >
              <Trash2 size={17} />
            </button>
          </div>
          <label>
            Название приложения
            <input
              value={a.name}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  applications: d.applications.map((v, j) =>
                    j === i ? { ...v, name: e.target.value } : v,
                  ),
                }))
              }
            />
          </label>
          <label>
            Псевдонимы
            <input
              value={a.aliases.join(", ")}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  applications: d.applications.map((v, j) =>
                    j === i
                      ? {
                          ...v,
                          aliases: e.target.value
                            .split(",")
                            .map((s) => s.trim()),
                        }
                      : v,
                  ),
                }))
              }
            />
          </label>
        </section>
      ))}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button
        className="primary w-full"
        disabled={saving}
        onClick={() => void save()}
      >
        <Save size={18} />
        {saving ? "Сохраняю…" : saved ? "Сохранено" : "Сохранить настройки"}
      </button>
      <h2>Устройства</h2>
      {devices
        .filter((d) => !d.revoked)
        .map((d) => (
          <div className="device row" key={d.id}>
            <div className="row">
              {d.role === "agent" ? (
                <Laptop size={20} />
              ) : (
                <Smartphone size={20} />
              )}
              <span>
                {d.name}
                <small className="muted block">
                  {d.online ? "Подключено" : "Не в сети"}
                  {d.role === "agent" && d.platform
                    ? " · " +
                      (d.platform === "win32"
                        ? "Windows"
                        : d.platform === "darwin"
                          ? "macOS"
                          : d.platform)
                    : ""}
                </small>
              </span>
            </div>
            <button
              className="small-button danger"
              onClick={() => {
                if (
                  window.confirm("Отозвать доступ устройства «" + d.name + "»?")
                )
                  void onRevoke(d.id).catch((e) => setError(e.message));
              }}
            >
              Отозвать
            </button>
          </div>
        ))}
      <p className="footnote">Секреты и команды запуска хранятся на компьютере.</p>
    </main>
  );
}
