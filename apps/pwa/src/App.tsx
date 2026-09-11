import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Mic, Square } from "lucide-react";
import type { CommandRecord } from "@voice/shared";
import { api, ApiError, post } from "./api";
import { InstallApp } from "./InstallApp";
import type { Device } from "./Settings";
import {
  foldSpeechResults,
  piecesFromSpeechEvent,
  preferLiveSpeechOnly,
  speechRecognitionCtor,
  type BrowserSpeechRecognition,
} from "./live-speech";
import {
  commandProgress,
  rememberSessionCommand,
  type SessionEntry,
} from "./session-history";

const terminal = (command: CommandRecord) =>
  ["done", "error", "cancelled", "clarification", "confirmation"].includes(
    command.status,
  );

export function App() {
  const [paired, setPaired] = useState(false);
  const [loading, setLoading] = useState(true);
  const [online, setOnline] = useState(false);
  const [recording, setRecording] = useState(false);
  const [sending, setSending] = useState(false);
  const [current, setCurrent] = useState<CommandRecord>();
  const [failed, setFailed] = useState(false);
  const [code, setCode] = useState("");
  const [liveFinal, setLiveFinal] = useState("");
  const [liveInterim, setLiveInterim] = useState("");
  const [recent, setRecent] = useState<SessionEntry[]>([]);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const blobFallback = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const discard = useRef(false);
  const listening = useRef(false);
  const recognition = useRef<BrowserSpeechRecognition | null>(null);
  const live = useRef({ final: "", interim: "" });
  const committed = useRef("");
  const heardVoice = useRef(false);

  const working = sending || !!(current && !terminal(current));
  const caption = [liveFinal, liveInterim].filter(Boolean).join(" ");
  const showCaption = !!caption;
  const progress = current ? commandProgress(current) : "";
  const update = (command: CommandRecord) => {
    setCurrent(command);
    setFailed(command.status === "error");
    setRecent((list) => rememberSessionCommand(list, command));
    const spoken = command.text.replace(/\s+/g, " ").trim();
    if (spoken && !live.current.final && !live.current.interim)
      setCaption(spoken, "");
  };

  async function load() {
    try {
      const devices = await api<Device[]>("/api/devices");
      setOnline(
        devices.some((device) => device.role === "agent" && device.online),
      );
      setPaired(true);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) setFailed(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    return () => stopRecording(true);
  }, []);

  useEffect(() => {
    if (!paired) return;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout>;
    let socket: WebSocket;
    const connect = () => {
      if (stopped) return;
      socket = new WebSocket(
        `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws/client`,
      );
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "devices")
          setOnline(
            message.devices.some(
              (device: Device) => device.role === "agent" && device.online,
            ),
          );
        if (message.type === "command") update(message.command);
      };
      socket.onclose = (event) => {
        if (stopped) return;
        setOnline(false);
        if (event.code === 4001) setPaired(false);
        else retry = setTimeout(connect, 1500);
      };
      socket.onerror = () => socket.close();
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      socket?.close();
    };
  }, [paired]);

  useEffect(() => {
    if (!current || terminal(current)) return;
    const poll = setInterval(() => {
      void api<CommandRecord>("/api/commands/" + current.id)
        .then(update)
        .catch(() => setFailed(true));
    }, 300);
    return () => clearInterval(poll);
  }, [current?.id, current?.status]);

  useEffect(() => {
    if (recording || !current || !terminal(current) || !caption) return;
    const hide = setTimeout(() => {
      live.current = { final: "", interim: "" };
      setLiveFinal("");
      setLiveInterim("");
    }, 1400);
    return () => clearTimeout(hide);
  }, [recording, current?.status, caption]);

  async function pair(event: React.FormEvent) {
    event.preventDefault();
    setSending(true);
    setFailed(false);
    try {
      await post("/api/auth/pair/complete", {
        code: code.replace(/\D/g, ""),
        name: "Телефон",
      });
      await load();
    } catch {
      setFailed(true);
    } finally {
      setSending(false);
    }
  }

  async function sendText(text: string) {
    const spoken = text.replace(/\s+/g, " ").trim();
    if (!spoken) {
      setFailed(true);
      return;
    }
    setSending(true);
    try {
      update(
        await post<CommandRecord>("/api/text-command", { text: spoken }),
      );
    } catch {
      setFailed(true);
    } finally {
      setSending(false);
    }
  }

  async function upload(blob: Blob) {
    setSending(true);
    const form = new FormData();
    form.append(
      "audio",
      blob,
      blob.type.includes("mp4") ? "recording.m4a" : "recording.webm",
    );
    try {
      update(
        await api<CommandRecord>("/api/voice", { method: "POST", body: form }),
      );
    } catch {
      setFailed(true);
    } finally {
      setSending(false);
    }
  }

  function setCaption(finalText: string, interimText: string) {
    live.current = { final: finalText, interim: interimText };
    setLiveFinal(finalText);
    setLiveInterim(interimText);
  }

  function clearTimers() {
    clearTimeout(blobFallback.current);
    blobFallback.current = undefined;
  }

  function stopRecording(cancel = false) {
    if (!listening.current && recorder.current?.state !== "recording") return;
    discard.current = cancel;
    listening.current = false;
    clearTimers();
    const spoken = [live.current.final, live.current.interim]
      .filter(Boolean)
      .join(" ")
      .trim();
    const blobWasRecording = recorder.current?.state === "recording";
    recognition.current?.stop();
    recognition.current = null;
    if (blobWasRecording) recorder.current?.stop();
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    setRecording(false);
    if (!blobWasRecording && !cancel) void sendText(spoken);
  }

  function startDictation() {
    const Ctor = speechRecognitionCtor();
    if (!Ctor) return false;
    const rec = new Ctor();
    rec.lang = "ru-RU";
    rec.continuous = !preferLiveSpeechOnly();
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onresult = (event) => {
      if (discard.current) return;
      const folded = foldSpeechResults(piecesFromSpeechEvent(event));
      heardVoice.current = true;
      setCaption(
        [committed.current, folded.finalText].filter(Boolean).join(" "),
        folded.interimText,
      );
    };
    rec.onerror = (event) => {
      if (!listening.current) return;
      if (
        event.error === "no-speech" ||
        event.error === "aborted" ||
        event.error === "network"
      )
        return;
      if (
        event.error === "not-allowed" ||
        event.error === "service-not-allowed"
      ) {
        if (recorder.current?.state === "recording") return;
        stopRecording(true);
        setFailed(true);
      }
    };
    rec.onend = () => {
      if (!listening.current || recognition.current !== rec) return;
      committed.current = live.current.final;
      try {
        rec.start();
      } catch {
        if (recorder.current?.state !== "recording")
          void startBlobRecording();
      }
    };
    try {
      rec.start();
    } catch {
      return false;
    }
    recognition.current = rec;
    return true;
  }

  async function startBlobRecording() {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
      return false;
    if (recorder.current?.state === "recording") return true;
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      stream.current = mediaStream;
      const mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find(
        (type) => MediaRecorder.isTypeSupported(type),
      );
      const mediaRecorder = new MediaRecorder(
        mediaStream,
        mime ? { mimeType: mime } : undefined,
      );
      recorder.current = mediaRecorder;
      const chunks: BlobPart[] = [];
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      mediaRecorder.onerror = () => {
        setFailed(true);
        stopRecording(true);
      };
      mediaRecorder.onstop = () => {
        mediaStream.getTracks().forEach((track) => track.stop());
        if (discard.current) return;
        const blob = new Blob(chunks, { type: mediaRecorder.mimeType });
        const spoken = [live.current.final, live.current.interim]
          .filter(Boolean)
          .join(" ")
          .trim();
        if (blob.size) void upload(blob);
        else if (spoken) void sendText(spoken);
        else setFailed(true);
      };
      mediaRecorder.start(200);
      return true;
    } catch {
      stream.current?.getTracks().forEach((track) => track.stop());
      stream.current = null;
      recorder.current = null;
      return false;
    }
  }

  async function startRecording() {
    setFailed(false);
    setCurrent(undefined);
    discard.current = false;
    listening.current = true;
    heardVoice.current = false;
    committed.current = "";
    setCaption("", "");
    const dictated = startDictation();
    if (preferLiveSpeechOnly() && dictated) {
      setRecording(true);
      blobFallback.current = setTimeout(() => {
        if (!listening.current || heardVoice.current) return;
        void startBlobRecording();
      }, 1600);
      return;
    }
    const startedBlob = await startBlobRecording();
    if (!startedBlob && !recognition.current) {
      listening.current = false;
      setFailed(true);
      return;
    }
    setRecording(true);
  }

  if (loading)
    return (
      <main className="single-screen">
        <LoaderCircle className="single-spinner" aria-label="Загрузка" />
      </main>
    );

  if (!paired)
    return (
      <>
        <main className="single-screen">
          <form className="pair-only" onSubmit={(event) => void pair(event)}>
            <input
              aria-label="Код подключения"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={8}
              value={code}
              onChange={(event) =>
                setCode(event.target.value.replace(/\D/g, ""))
              }
            />
            <button
              disabled={sending || code.length !== 8}
              aria-label="Подключить"
            >
              {sending ? <LoaderCircle className="spin" /> : <Mic />}
            </button>
          </form>
        </main>
        <InstallApp />
      </>
    );

  return (
    <>
      <main className="single-screen">
        <div className="single-stage">
          <button
            className={`single-record ${recording ? "is-recording" : ""} ${working ? "is-working" : ""} ${failed || !online ? "is-failed" : ""}`}
            aria-label={recording ? "Остановить запись" : "Записать команду"}
            disabled={!online || working}
            onClick={() =>
              recording ? stopRecording() : void startRecording()
            }
          >
            {recording ? (
              <Square fill="currentColor" />
            ) : working ? (
              <LoaderCircle className="spin" />
            ) : (
              <Mic />
            )}
          </button>
        </div>
        {recording || showCaption || progress || recent.length ? (
          <div className="stage-overlay">
            {recording || showCaption ? (
              <p className="live-caption" aria-live="polite">
                {liveFinal ? <span>{liveFinal}</span> : null}
                {liveInterim ? (
                  <span className="is-interim">
                    {liveFinal ? " " : ""}
                    {liveInterim}
                  </span>
                ) : null}
                {!liveFinal && !liveInterim && recording ? (
                  <span className="is-interim">…</span>
                ) : null}
              </p>
            ) : null}
            {progress ? (
              <p
                className={`command-status ${working ? "is-working" : ""} ${current?.status === "error" ? "is-error" : ""} ${current?.status === "done" ? "is-done" : ""}`}
                aria-live="polite"
              >
                {progress}
              </p>
            ) : null}
            {recent.length ? (
              <ol className="session-history" aria-label="Последние команды">
                {recent.map((item) => (
                  <li
                    key={item.id}
                    className={item.failed ? "is-error" : undefined}
                  >
                    {item.text}
                  </li>
                ))}
              </ol>
            ) : null}
          </div>
        ) : null}
      </main>
      <InstallApp hidden={recording || working} />
    </>
  );
}
