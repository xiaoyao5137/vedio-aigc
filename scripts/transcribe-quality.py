"""Local, timestamped ASR evidence. This does not certify lip synchronization."""
import argparse
import json
import re
from pypinyin import lazy_pinyin, Style
from faster_whisper import WhisperModel
from speech_boundaries import align_speech_windows
from speech_pronunciation import assess_pronunciation_text

parser = argparse.ArgumentParser()
parser.add_argument('video')
parser.add_argument('--model', default='small')
parser.add_argument('--expected', default='')
parser.add_argument('--windows', default='[]')
parser.add_argument('--latest-speech-end', type=float, default=13.5)
args = parser.parse_args()
model = WhisperModel(args.model, device='cpu', compute_type='int8')
segments, info = model.transcribe(args.video, language='zh', beam_size=5, word_timestamps=True, vad_filter=True)
rows = [{'start': s.start, 'end': s.end, 'text': s.text,
    'words': [{'start': w.start, 'end': w.end, 'word': w.word, 'probability': w.probability} for w in s.words or []]} for s in segments]
result = {'language': info.language, 'segments': rows}
if args.expected:
    expected = re.sub(r'(?m)^[^：:\n]{1,20}[：:]', '', args.expected)
    def sounds(text):
        return lazy_pinyin(''.join(re.findall(r'[\u3400-\u9fff]', text)), style=Style.NORMAL)
    def lexical_tones(text):
        return lazy_pinyin(''.join(re.findall(r'[\u3400-\u9fff]', text)), style=Style.TONE3, neutral_tone_with_five=True)
    pronunciation = assess_pronunciation_text(expected, ''.join(row['text'] for row in rows), sounds, lexical_tones)
    error_rate = pronunciation['syllableTextErrorRate']
    last_word_end = max((word['end'] for row in rows for word in row['words']), default=0)
    issues = []
    if not pronunciation['recognizedSyllables'] or error_rate > 0.2:
        issues.append(f'ASR 转写与计划文本的无调音节差异过大，文本音节错误率 {error_rate:.1%}；非实测音素或声调错误率')
    if last_word_end > args.latest_speech_end + 0.25:
        issues.append(f'最后人声延续至 {last_word_end:.2f} 秒，侵入稳定尾帧')
    alignment = align_speech_windows(rows, json.loads(args.windows), sounds)
    for row in alignment:
        if row['boundaryStatus'] != 'reliable':
            issues.append('台词首尾或对齐证据不确定，须复核同一素材音频：' + row['planned']['text'])
    result['speechValidation'] = {'passed': not issues, 'alignment': alignment, 'issues': issues, 'phoneticErrorRate': error_rate,
        'phoneticErrorRateMeaning': 'toneless-asr-text-syllable-edit-distance', 'pronunciationAssessment': pronunciation,
        'lastSpeechEnd': last_word_end, 'lipSyncVerified': False, 'alignmentVersion': 2,
        'dialogueCompletenessVerified': bool(alignment) and all(row['boundaryStatus'] == 'reliable' for row in alignment) and error_rate <= .2,
        'method': 'local-whisper-small-phonetic-alignment'}
print(json.dumps(result, ensure_ascii=False))
