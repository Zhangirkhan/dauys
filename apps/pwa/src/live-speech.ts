export type SpeechPiece = { transcript: string; isFinal: boolean };

export function foldSpeechResults(results: SpeechPiece[]) {
  const finals: string[] = [];
  const interims: string[] = [];
  for (const piece of results) {
    const text = piece.transcript.replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (piece.isFinal) finals.push(text);
    else interims.push(text);
  }
  const finalText = finals.join(" ").trim();
  const interimText = interims.join(" ").trim();
  return {
    finalText,
    interimText,
    display: [finalText, interimText].filter(Boolean).join(" "),
  };
}

export type BrowserSpeechRecognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
};

export type BrowserSpeechRecognitionEvent = {
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string };
  }>;
};

export function speechRecognitionCtor():
  | (new () => BrowserSpeechRecognition)
  | undefined {
  const speechWindow = window as unknown as {
    SpeechRecognition?: new () => BrowserSpeechRecognition;
    webkitSpeechRecognition?: new () => BrowserSpeechRecognition;
  };
  return (
    speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition
  );
}

export function preferLiveSpeechOnly(
  nav: Pick<
    Navigator,
    "userAgent" | "platform" | "maxTouchPoints" | "webdriver"
  > = navigator,
) {
  if (nav.webdriver) return false;
  return (
    /iPhone|iPad|iPod/i.test(nav.userAgent) ||
    (nav.platform === "MacIntel" && nav.maxTouchPoints > 1)
  );
}

export function piecesFromSpeechEvent(event: BrowserSpeechRecognitionEvent) {
  const pieces: SpeechPiece[] = [];
  for (let i = 0; i < event.results.length; i++) {
    const result = event.results[i];
    pieces.push({
      transcript: result[0]?.transcript ?? "",
      isFinal: result.isFinal,
    });
  }
  return pieces;
}
