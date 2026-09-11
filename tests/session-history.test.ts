import { describe, expect, it } from "vitest";
import { rememberSessionCommand, commandProgress } from "../apps/pwa/src/session-history.js";

const command = (
  id: string,
  text: string,
  status: string,
  createdAt: number,
) => ({ id, text, status, createdAt });

describe("session command list", () => {
  it("keeps the newest five finished commands", () => {
    let list = rememberSessionCommand([], command("1", "один", "done", 1));
    list = rememberSessionCommand(list, command("2", "два", "done", 2));
    list = rememberSessionCommand(list, command("3", "три", "error", 3));
    list = rememberSessionCommand(
      list,
      command("4", "четыре", "processing", 4),
    );
    list = rememberSessionCommand(list, command("5", "пять", "done", 5));
    list = rememberSessionCommand(list, command("6", "шесть", "done", 6));
    list = rememberSessionCommand(list, command("7", "семь", "done", 7));
    expect(list.map((item) => item.text)).toEqual([
      "семь",
      "шесть",
      "пять",
      "четыре",
      "три",
    ]);
    expect(list[4]?.failed).toBe(true);
  });

  it("turns command status into a short line under the mic", () => {
    expect(
      commandProgress({
        status: "processing",
        decision: { spokenResponse: "Ищу на диске: отчет коктем" },
      }),
    ).toBe("Ищу на диске: отчет коктем");
    expect(
      commandProgress({
        status: "done",
        result: { message: "Открыто: Отчет_Коктем.txt" },
      }),
    ).toBe("Открыто: Отчет_Коктем.txt");
    expect(commandProgress({ status: "executing" })).toBe("Выполняю на Mac…");
  });

  it("updates an existing command without duplicating it", () => {
    let list = rememberSessionCommand(
      [],
      command("1", "открой ватсап", "error", 10),
    );
    list = rememberSessionCommand(
      list,
      command("1", "открой ватсап", "done", 10),
    );
    expect(list).toEqual([
      {
        id: "1",
        text: "открой ватсап",
        failed: false,
        createdAt: 10,
      },
    ]);
  });
});
