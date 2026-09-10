import { useEffect, useState } from "react";
import { Download, Share, X } from "lucide-react";

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

function isStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    Boolean((navigator as Navigator & { standalone?: boolean }).standalone)
  );
}

function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

export function InstallApp({ hidden = false }: { hidden?: boolean }) {
  const [available, setAvailable] = useState(() => !isStandalone());
  const [promptEvent, setPromptEvent] = useState<InstallPromptEvent | null>(
    null,
  );
  const [help, setHelp] = useState(false);
  const ios = isIOS();

  useEffect(() => {
    if (isStandalone()) {
      setAvailable(false);
      return;
    }
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setPromptEvent(event as InstallPromptEvent);
    };
    const onInstalled = () => {
      setAvailable(false);
      setHelp(false);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (!available || hidden) return null;

  async function download() {
    if (promptEvent) {
      await promptEvent.prompt();
      const { outcome } = await promptEvent.userChoice;
      if (outcome === "accepted") setAvailable(false);
      setPromptEvent(null);
      return;
    }
    setHelp(true);
  }

  return (
    <>
      <button
        type="button"
        className="install-app"
        onClick={() => void download()}
      >
        <Download />
        Скачать приложение
      </button>
      {help ? (
        <div
          className="install-help"
          role="dialog"
          aria-label="Как скачать приложение"
        >
          <button
            type="button"
            className="install-help-close"
            aria-label="Закрыть"
            onClick={() => setHelp(false)}
          >
            <X />
          </button>
          {ios ? (
            <ol>
              <li>
                Нажмите <Share aria-hidden /> «Поделиться»
              </li>
              <li>Выберите «На экран „Домой“»</li>
              <li>Нажмите «Добавить»</li>
            </ol>
          ) : (
            <p>
              В меню браузера выберите «Установить приложение» или «Добавить на
              главный экран».
            </p>
          )}
        </div>
      ) : null}
    </>
  );
}
