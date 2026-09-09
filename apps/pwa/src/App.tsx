import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Mic, Square } from "lucide-react";
import type { CommandRecord } from "@voice/shared";
import { api, ApiError, post } from "./api";
import type { Device } from "./Settings";

/** Конечные статусы: polling можно остановить. */
const finished = (command: CommandRecord) =>
  ["done", "error", "cancelled"].includes(command.status);

/** Пока команда жива (в т.ч. confirmation/clarification) — микрофон занят. */
const inFlight = (command: CommandRecord) => !finished(command);

function stageLabel(
  recording: boolean,
  sending: boolean,
  command?: CommandRecord,
): string {
  if (recording) return "Запись";
  if (sending) return "Отправка";
  if (!command) return "";
  switch (command.status) {
    case "transcribing":
      return "Распознавание";
    case "processing":
      return "Распознавание";
    case "executing":
      return "Выполнение";
    case "confirmation":
      return "Подтверждение";
    case "clarification":
      return "Уточнение";
    case "done":
      return "Готово";
    case "error":
      return "Ошибка";
    case "cancelled":
      return "Отменено";
    default:
      return "Выполнение";
  }
}

function commandHint(command: CommandRecord): string {
  const action = command.command?.action;
  const params = command.command?.parameters as
    | Record<string, string | undefined>
    | undefined;
  if (action === "open_url" && params?.url) return `Открыть ${params.url}`;
  if (action === "open_application" && params?.applicationId)
    return `Открыть приложение: ${params.applicationId}`;
  if (action === "open_named_item" && params?.query)
    return `Открыть: ${params.query}`;
  if (action) return action;
  return command.text || "Команда";
}

export function App() {
  const [paired, setPaired] = useState(false);
  const [loading, setLoading] = useState(true);
  const [online, setOnline] = useState(false);
  const [recording, setRecording] = useState(false);
  const [sending, setSending] = useState(false);
  const [current, setCurrent] = useState<CommandRecord>();
  const [failed, setFailed] = useState(false);
  const [clarifyAnswer, setClarifyAnswer] = useState("");
  const [acting, setActing] = useState(false);
  const [code, setCode] = useState("");
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const silenceFrame = useRef<number | undefined>(undefined);
  const audioContext = useRef<AudioContext | null>(null);
  const discard = useRef(false);

  const working = sending || !!(current && inFlight(current));
  const update = (command: CommandRecord) => {
    setCurrent(command);
    setFailed(command.status === "error");
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

  // Poll until done/error/cancelled (включая confirmation/clarification → итог).
  useEffect(() => {
    if (!current || finished(current)) return;
    const poll = setInterval(() => {
      void api<CommandRecord>("/api/commands/" + current.id)
        .then(update)
        .catch(() => setFailed(true));
    }, 300);
    return () => clearInterval(poll);
  }, [current?.id, current?.status]);

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

  function stopRecording(cancel = false) {
    discard.current = cancel;
    clearTimeout(timeout.current);
    if (silenceFrame.current) cancelAnimationFrame(silenceFrame.current);
    void audioContext.current?.close().catch(() => undefined);
    audioContext.current = null;
    if (recorder.current?.state === "recording") recorder.current.stop();
    stream.current?.getTracks().forEach((track) => track.stop());
    setRecording(false);
  }

  function detectSilence(mediaStream: MediaStream) {
    const Context =
      window.AudioContext ??
      (window as typeof window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Context) return;
    const context = new Context();
    audioContext.current = context;
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    context.createMediaStreamSource(mediaStream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const startedAt = performance.now();
    let heardVoice = false;
    let lastVoiceAt = startedAt;
    const inspect = () => {
      if (recorder.current?.state !== "recording") return;
      analyser.getFloatTimeDomainData(samples);
      const rms = Math.sqrt(
        samples.reduce((sum, value) => sum + value * value, 0) / samples.length,
      );
      const now = performance.now();
      if (rms > 0.018) {
        heardVoice = true;
        lastVoiceAt = now;
      }
      if (heardVoice && now - lastVoiceAt > 550 && now - startedAt > 800) {
        stopRecording();
        return;
      }
      silenceFrame.current = requestAnimationFrame(inspect);
    };
    silenceFrame.current = requestAnimationFrame(inspect);
  }

  async function startRecording() {
    setFailed(false);
    setCurrent(undefined);
    setClarifyAnswer("");
    discard.current = false;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setFailed(true);
      return;
    }
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
        if (blob.size) void upload(blob);
        else setFailed(true);
      };
      mediaRecorder.start(200);
      setRecording(true);
      detectSilence(mediaStream);
      timeout.current = setTimeout(() => stopRecording(), 8_000);
    } catch {
      setFailed(true);
      setRecording(false);
    }
  }

  async function confirmCommand() {
    if (!current) return;
    setActing(true);
    try {
      update(
        await post<CommandRecord>("/api/commands/" + current.id + "/confirm", {
          approved: true,
        }),
      );
    } catch {
      setFailed(true);
    } finally {
      setActing(false);
    }
  }

  async function cancelCommand() {
    if (!current) return;
    setActing(true);
    try {
      update(
        await post<CommandRecord>("/api/commands/" + current.id + "/cancel", {}),
      );
    } catch {
      setFailed(true);
    } finally {
      setActing(false);
    }
  }

  async function clarifyCommand(answer: string) {
    if (!current || !answer.trim()) return;
    setActing(true);
    try {
      update(
        await post<CommandRecord>("/api/commands/" + current.id + "/clarify", {
          answer: answer.trim(),
        }),
      );
      setClarifyAnswer("");
    } catch {
      setFailed(true);
    } finally {
      setActing(false);
    }
  }

  const label = stageLabel(recording, sending, current);
  const outcome =
    current?.result?.message ||
    (failed && !current ? "Не удалось выполнить запрос" : "");

  if (loading)
    return (
      <main className="single-screen">
        <LoaderCircle className="single-spinner" aria-label="Загрузка" />
      </main>
    );

  if (!paired)
    return (
      <main className="single-screen">
        <form className="pair-only" onSubmit={(event) => void pair(event)}>
          <input
            aria-label="Код подключения"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={8}
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
          />
          <button
            disabled={sending || code.length !== 8}
            aria-label="Подключить"
          >
            {sending ? <LoaderCircle className="spin" /> : <Mic />}
          </button>
        </form>
      </main>
    );

  return (
    <main className="single-screen">
      <button
        className={`single-record ${recording ? "is-recording" : ""} ${working ? "is-working" : ""} ${failed || !online ? "is-failed" : ""}`}
        aria-label={recording ? "Остановить запись" : "Записать команду"}
        disabled={!online || working || acting}
        onClick={() => (recording ? stopRecording() : void startRecording())}
      >
        {recording ? (
          <Square fill="currentColor" />
        ) : working ? (
          <LoaderCircle className="spin" />
        ) : (
          <Mic />
        )}
      </button>

      <div className="voice-status" aria-live="polite">
        {label ? <p className="voice-stage">{label}</p> : null}
        {!online ? (
          <p className="voice-hint">Агент офлайн</p>
        ) : null}
        {current?.text ? (
          <p className="voice-transcript">{current.text}</p>
        ) : null}
        {outcome ? (
          <p
            className={
              current?.status === "error" || failed
                ? "voice-error"
                : "voice-result"
            }
          >
            {outcome}
          </p>
        ) : null}

        {current?.status === "confirmation" ? (
          <div className="voice-actions">
            <p className="voice-hint">{commandHint(current)}</p>
            <button
              type="button"
              disabled={acting}
              onClick={() => void confirmCommand()}
            >
              Подтвердить
            </button>
            <button
              type="button"
              className="is-secondary"
              disabled={acting}
              onClick={() => void cancelCommand()}
            >
              Отмена
            </button>
          </div>
        ) : null}

        {current?.status === "clarification" ? (
          <div className="voice-actions">
            {current.question ? (
              <p className="voice-hint">{current.question}</p>
            ) : null}
            {current.options?.length ? (
              <div className="voice-options">
                {current.options.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    disabled={acting}
                    onClick={() => void clarifyCommand(option.id)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            ) : null}
            <form
              className="voice-clarify"
              onSubmit={(event) => {
                event.preventDefault();
                void clarifyCommand(clarifyAnswer);
              }}
            >
              <input
                aria-label="Ответ"
                value={clarifyAnswer}
                disabled={acting}
                onChange={(event) => setClarifyAnswer(event.target.value)}
                placeholder="Ответ…"
              />
              <button type="submit" disabled={acting || !clarifyAnswer.trim()}>
                Отправить
              </button>
            </form>
            <button
              type="button"
              className="is-secondary"
              disabled={acting}
              onClick={() => void cancelCommand()}
            >
              Отмена
            </button>
          </div>
        ) : null}
      </div>
    </main>
  );
}
