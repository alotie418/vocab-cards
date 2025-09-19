import React, { useState, useEffect } from 'react';

/**
 * Parse a simple CSV string into an array of objects. The first row is
 * expected to contain the header names. This parser is lightweight and
 * does not handle nested quotes or escaped commas. For more complex
 * datasets you may wish to swap this out for a dedicated CSV parser.
 *
 * @param {string} text The CSV data as text
 * @returns {Array<Object>} Parsed rows as objects keyed by the header names
 */
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length === 0) return [];
  const headers = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const values = line.split(',');
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = (values[idx] || '').trim();
    });
    return obj;
  });
}

/**
 * Fetch phonetics, audio and a definition for a given word using the
 * dictionaryapi.dev API. This function returns empty strings on
 * failure so that callers can merge the data gracefully into their
 * existing card structure.
 *
 * @param {string} word The word to look up
 * @returns {Promise<{ipa: string, audio: string, meaning: string}>}
 */
async function fetchDictionary(word) {
  try {
    const res = await fetch(
      `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(
        word,
      )}`,
    );
    if (!res.ok) throw new Error('Dictionary fetch failed');
    const data = await res.json();
    const entry = data[0] || {};
    let ipa = '';
    let audio = '';
    if (entry.phonetics && entry.phonetics.length > 0) {
      // Prefer a phonetics entry with a text IPA representation
      const withText = entry.phonetics.find((p) => p.text);
      const withAudio = entry.phonetics.find((p) => p.audio);
      if (withText && typeof withText.text === 'string') ipa = withText.text;
      if (withAudio && typeof withAudio.audio === 'string') audio = withAudio.audio;
    }
    let meaning = '';
    if (entry.meanings && entry.meanings.length > 0) {
      const defs = entry.meanings[0].definitions;
      if (defs && defs.length > 0 && defs[0].definition) {
        meaning = defs[0].definition;
      }
    }
    return { ipa, audio, meaning };
  } catch (err) {
    // On any error return empty values so the caller can proceed.
    return { ipa: '', audio: '', meaning: '' };
  }
}

/**
 * Pronounce a word via the Web Speech API. Falls back gracefully if
 * speech synthesis isn't available.
 *
 * @param {string} word The word to pronounce
 */
function pronounce(word) {
  if (typeof window === 'undefined' || !window.speechSynthesis) return;
  const utterance = new SpeechSynthesisUtterance(word);
  utterance.lang = 'en-US';
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

const STORAGE_KEY = 'vocabCards';

/**
 * The main application component responsible for rendering the UI, handling
 * file import/export, managing the spaced repetition algorithm and
 * pronouncing words. This component uses functional React hooks for state
 * management and side effects.
 */
export default function App() {
  const [cards, setCards] = useState([]);
  const [currentCard, setCurrentCard] = useState(null);
  const [showAnswer, setShowAnswer] = useState(false);
  const [autoComplete, setAutoComplete] = useState(true);

  // Automatically pronounce the current card when it becomes due. If the card
  // includes an audio URL it will be played; otherwise the TTS engine
  // pronounces the word. Autoplay may be blocked by some browsers until
  // the user interacts with the page, but subsequent cards will pronounce
  // correctly after an initial click.
  useEffect(() => {
    if (currentCard) {
      // Delay slightly to avoid race conditions with state updates
      const timer = setTimeout(() => {
        try {
          if (currentCard.audio) {
            const audio = new Audio(currentCard.audio);
            audio.play().catch(() => {
              pronounce(currentCard.word);
            });
          } else {
            pronounce(currentCard.word);
          }
        } catch {
          // If anything fails, fall back to TTS
          pronounce(currentCard.word);
        }
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [currentCard]);

  // Load any persisted cards from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) setCards(parsed);
      }
    } catch {
      // ignore JSON parse errors
    }
  }, []);

  // Persist cards whenever they change
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cards));
    // Pick the next due card whenever the cards update
    pickNextCard(cards);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards]);

  /**
   * Select the next due card. Cards are due if their `due` property is
   * earlier than or equal to the current time. If none are due, the
   * currentCard is set to null.
   *
   * @param {Array<Object>} allCards The complete list of cards
   */
  function pickNextCard(allCards) {
    const now = Date.now();
    const dueCards = allCards.filter((c) => (c.due ?? 0) <= now);
    if (dueCards.length > 0) {
      setCurrentCard(dueCards[0]);
      setShowAnswer(false);
    } else {
      setCurrentCard(null);
    }
  }

  /**
   * Handle file selection events. Supports CSV and JSON. For CSV, the first
   * line is treated as the header. The following columns are recognised:
   * `word`, `ipa`, `audio`, `meaning`, `example`. Additional columns
   * are ignored. Cards are assigned an ID and scheduled as due now.
   *
   * If `autoComplete` is enabled, missing IPA, audio and meaning fields
   * are filled by asynchronous lookups to dictionaryapi.dev.
   */
  async function handleFileImport(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    let importedRows = [];
    try {
      const text = await file.text();
      if (file.name.toLowerCase().endsWith('.json')) {
        const data = JSON.parse(text);
        if (Array.isArray(data)) importedRows = data;
      } else {
        importedRows = parseCSV(text);
      }
    } catch (err) {
      console.error('Failed to parse file', err);
      return;
    }
    const newCards = [];
    for (const entry of importedRows) {
      const rawWord = entry.word || entry.Word || entry.term || entry.Term || '';
      const word = rawWord.toString().trim();
      if (!word) continue;
      const card = {
        id: `${Date.now()}-${Math.random()}`,
        word,
        ipa: entry.ipa || entry.IPA || '',
        audio: entry.audio || entry.Audio || '',
        meaning: entry.meaning || entry.Meaning || '',
        example: entry.example || entry.Example || '',
        ease: 2.5,
        interval: 0,
        due: Date.now(),
      };
      if (autoComplete && (!card.ipa || !card.meaning || !card.audio)) {
        // Attempt to fetch missing fields from dictionary API
        const fetched = await fetchDictionary(card.word);
        card.ipa = card.ipa || fetched.ipa;
        card.audio = card.audio || fetched.audio;
        card.meaning = card.meaning || fetched.meaning;
      }
      newCards.push(card);
    }
    // Merge new cards into existing list and reset input
    setCards((prev) => [...prev, ...newCards]);
    event.target.value = '';
  }

  /**
   * Update a card's scheduling parameters based on user feedback. This
   * implements a simplified SM‑2 algorithm. Ease values decrease when
   * answered incorrectly and increase slightly when answered correctly.
   * Interval values grow multiplicatively by the ease factor on correct
   * responses, and reset to 1 day for incorrect responses.
   *
   * @param {Object} card The card to update
   * @param {string} rating One of 'again', 'hard', 'good'
   */
  function updateCard(card, rating) {
    let { ease, interval } = card;
    if (rating === 'again') {
      ease = Math.max(ease - 0.2, 1.3);
      interval = 1;
    } else if (rating === 'hard') {
      ease = ease + 0.05;
      interval = Math.max(1, Math.ceil(interval * 1.2));
    } else if (rating === 'good') {
      ease = ease + 0.1;
      interval = interval > 0 ? Math.ceil(interval * ease) : 2;
    }
    const due = Date.now() + interval * 24 * 60 * 60 * 1000;
    const updated = { ...card, ease, interval, due };
    setCards((prev) => prev.map((c) => (c.id === card.id ? updated : c)));
  }

  /**
   * Export the current cards array as a JSON file. This uses a data URL
   * approach to trigger the download in the browser.
   */
  function exportJSON() {
    const dataStr =
      'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(cards, null, 2));
    const anchor = document.createElement('a');
    anchor.setAttribute('href', dataStr);
    anchor.setAttribute('download', 'vocab_cards.json');
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }

  /**
   * Export the current cards array as a CSV file. Includes scheduling
   * metadata such as ease, interval and due in addition to the primary
   * vocabulary fields.
   */
  function exportCSV() {
    const headers = [
      'word',
      'ipa',
      'audio',
      'meaning',
      'example',
      'ease',
      'interval',
      'due',
    ];
    const rows = cards.map((c) => headers.map((h) => (c[h] ?? '')).join(','));
    const csv = [headers.join(','), ...rows].join('\n');
    const dataStr = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
    const anchor = document.createElement('a');
    anchor.setAttribute('href', dataStr);
    anchor.setAttribute('download', 'vocab_cards.csv');
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-6">
      <h1
        className="text-4xl font-extrabold mb-6 text-center bg-gradient-to-r from-blue-500 via-purple-500 to-pink-500 text-white py-4 rounded-xl shadow-md"
      >
        Vocabulary Cards
      </h1>
      {/* File import and settings */}
      <div className="mb-8 bg-white border border-gray-200 rounded-xl p-6 shadow-md">
        <label className="block text-sm font-medium text-gray-700 mb-2">导入词汇表：</label>
        <input
          type="file"
          accept=".csv,.json"
          onChange={handleFileImport}
          className="block w-full text-sm text-gray-900 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 cursor-pointer"
        />
        <div className="mt-4 flex items-center">
          <input
            id="autocomplete"
            type="checkbox"
            checked={autoComplete}
            onChange={() => setAutoComplete((v) => !v)}
            className="mr-2 h-4 w-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"
          />
          <label htmlFor="autocomplete" className="text-sm text-gray-700 select-none">
            自动补全音标与释义
          </label>
        </div>
      </div>
      {/* Export buttons */}
      <div className="mb-10 flex space-x-3 justify-center">
        <button
          onClick={exportJSON}
          className="bg-blue-500 hover:bg-blue-600 text-white px-5 py-2 rounded-xl font-medium"
        >
          导出 JSON
        </button>
        <button
          onClick={exportCSV}
          className="bg-green-500 hover:bg-green-600 text-white px-5 py-2 rounded-xl font-medium"
        >
          导出 CSV
        </button>
      </div>
      {/* Card review area */}
      {currentCard ? (
        <div>
          <div
            className="bg-white border border-gray-200 rounded-2xl p-6 shadow-lg hover:shadow-xl transition-shadow cursor-pointer"
            onClick={() => setShowAnswer((v) => !v)}
          >
            <h2 className="text-2xl font-bold mb-2 text-gray-800">{currentCard.word}</h2>
            {currentCard.ipa && (
              <div className="text-indigo-600 font-mono mb-3">{currentCard.ipa}</div>
            )}
            {currentCard.audio ? (
              <audio controls src={currentCard.audio} className="mt-2" />
            ) : (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  pronounce(currentCard.word);
                }}
                className="mt-2 bg-purple-500 hover:bg-purple-600 text-white px-4 py-2 rounded-lg"
              >
                🔊 语音
              </button>
            )}
            {showAnswer ? (
              <div className="mt-4 text-gray-700 leading-relaxed">
                {currentCard.meaning && (
                  <p>
                    <span className="font-semibold">释义：</span> {currentCard.meaning}
                  </p>
                )}
                {currentCard.example && (
                  <p className="mt-3">
                    <span className="font-semibold">例句：</span> {currentCard.example}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-gray-400 mt-3">点击卡片查看释义和例句</p>
            )}
          </div>
          {/* Rating buttons */}
          <div className="mt-5 grid grid-cols-3 gap-3">
            <button
              onClick={() => updateCard(currentCard, 'again')}
              className="bg-red-500 hover:bg-red-600 text-white font-medium py-3 rounded-xl"
            >
              Again
            </button>
            <button
              onClick={() => updateCard(currentCard, 'hard')}
              className="bg-yellow-500 hover:bg-yellow-600 text-white font-medium py-3 rounded-xl"
            >
              Hard
            </button>
            <button
              onClick={() => updateCard(currentCard, 'good')}
              className="bg-green-500 hover:bg-green-600 text-white font-medium py-3 rounded-xl"
            >
              Good
            </button>
          </div>
        </div>
      ) : (
        <p className="text-gray-600 mt-4">当前没有到期卡片，请导入词汇表或等待下一次复习。</p>
      )}
    </div>
  );
}
