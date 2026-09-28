"""Pure ASR alignment: candidate timestamps never certify an unheard phoneme.

No model or pinyin import occurs here. The caller supplies phonetic tokenization
so saved ASR can be rechecked without loading Whisper or generating new media.
"""
import math
import re
from difflib import SequenceMatcher


def _time(value):
    return isinstance(value, (int, float)) and math.isfinite(value)


def align_speech_windows(segments, windows, tokenize):
    # Determine contextual readings before assigning syllables to their source
    # words. Isolated-word conversion incorrectly reads 银 / 行 as yin / xing
    # even when the unchanged full ASR transcript is 银行 (yin / hang).
    characters = lambda text: re.findall(r'[\u3400-\u9fff]', text)
    origins = []
    for segment_index, segment in enumerate(segments):
        for word in segment.get('words', []):
            origins.extend({'character': character, 'word': word, 'segment': segment_index}
                           for character in characters(word.get('word', '')))
    contextual = tokenize(''.join(origin['character'] for origin in origins))
    tokenization_reasons = [] if len(contextual) == len(origins) else ['contextual-token-count-mismatch']
    tokens = [{**origin, 'sound': sound} for origin, sound in zip(origins, contextual)] if not tokenization_reasons else []
    expected = [sound for window in windows for sound in tokenize(window.get('text', ''))]
    recognized = [token['sound'] for token in tokens]
    mapping = {}
    for block in SequenceMatcher(None, expected, recognized, autojunk=False).get_matching_blocks():
        mapping.update({block.a + n: block.b + n for n in range(block.size)})
    alignment, offset = [], 0
    for window in windows:
        count = len(tokenize(window.get('text', '')))
        stop = offset + count
        matched_indices = [i for i in range(offset, stop) if i in mapping]
        first_matched = bool(count and offset in mapping)
        last_matched = bool(count and stop - 1 in mapping)
        reasons = tokenization_reasons.copy()
        if not first_matched:
            reasons.append('first-token-unmatched')
        if not last_matched:
            reasons.append('last-token-unmatched')
        if len(matched_indices) != count or not count:
            reasons.append('partial-phonetic-alignment' if count else 'nonlexical-vocalization-needs-audio-review')
        matched_start = matched_end = candidate_start = candidate_end = None
        candidate = None
        if matched_indices:
            first_index, last_index = mapping[matched_indices[0]], mapping[matched_indices[-1]]
            first_word, last_word = tokens[first_index]['word'], tokens[last_index]['word']
            matched_start, matched_end = first_word.get('start'), last_word.get('end')
            if (first_index > 0 and tokens[first_index - 1]['word'] is first_word
                    or last_index + 1 < len(tokens) and tokens[last_index + 1]['word'] is last_word):
                reasons.append('planned-boundary-inside-asr-word')
            # Extend only by missing edge phonemes, and never consume a token
            # already anchored to another planned utterance. Segment-wide spans
            # would otherwise swallow the following line or an unrelated "好".
            preceding = max((v for k, v in mapping.items() if k < offset), default=-1)
            following = min((v for k, v in mapping.items() if k >= stop), default=len(tokens))
            lower = max(preceding + 1, first_index - (matched_indices[0] - offset))
            upper = min(following, last_index + 1 + (stop - 1 - matched_indices[-1]))
            selected = tokens[lower:upper]
            candidate_start = selected[0]['word'].get('start')
            candidate_end = selected[-1]['word'].get('end')
            segment_indices = sorted({token['segment'] for token in selected})
            candidate_words = []
            for token in selected:
                if not candidate_words or candidate_words[-1] is not token['word']:
                    candidate_words.append(token['word'])
            # Retain disagreements between word and segment timing. The segment
            # bounds may be VAD/decoder approximations; neither wins silently.
            for edge, selected_index, direction in [('start', lower, -1), ('end', upper - 1, 1)]:
                segment_index = tokens[selected_index]['segment']
                neighbor = selected_index + direction
                at_segment_edge = neighbor < 0 or neighbor >= len(tokens) or tokens[neighbor]['segment'] != segment_index
                segment_time = segments[segment_index].get(edge)
                word_time = tokens[selected_index]['word'].get(edge)
                if at_segment_edge and _time(segment_time) and _time(word_time) and abs(segment_time - word_time) > .15:
                    reasons.append('segment-word-' + edge + '-disagreement')
                    if edge == 'start':
                        candidate_start = min(candidate_start, segment_time)
                    else:
                        candidate_end = max(candidate_end, segment_time)
            if preceding >= 0 and _time(candidate_start) and _time(tokens[preceding]['word'].get('end')) and candidate_start < tokens[preceding]['word']['end']:
                reasons.append('adjacent-utterance-boundary-overlap')
                candidate_start = tokens[preceding]['word']['end']
            if following < len(tokens) and _time(candidate_end) and _time(tokens[following]['word'].get('start')) and candidate_end > tokens[following]['word']['start']:
                reasons.append('adjacent-utterance-boundary-overlap')
                candidate_end = tokens[following]['word']['start']
            for index in [first_index, last_index]:
                probability = tokens[index]['word'].get('probability')
                if not _time(probability) or probability < .3:
                    reasons.append('edge-word-confidence-insufficient')
            if any(not _time(word.get('start')) or not _time(word.get('end')) or word['end'] <= word['start'] for word in candidate_words):
                reasons.append('invalid-word-timestamps')
            if any(_time(candidate_words[i].get('start')) and _time(candidate_words[i - 1].get('end')) and candidate_words[i]['start'] < candidate_words[i - 1]['end'] - .15 for i in range(1, len(candidate_words))):
                reasons.append('overlapping-word-timestamps')
            for segment_index in segment_indices:
                segment = segments[segment_index]
                if characters(segment.get('text', '')) != [character for word in segment.get('words', []) for character in characters(word.get('word', ''))]:
                    reasons.append('segment-word-text-disagreement')
            candidate = {'start': candidate_start, 'end': candidate_end,
                         'text': ''.join(word.get('word', '') for word in candidate_words),
                         'words': candidate_words, 'segmentIndices': segment_indices,
                         'segments': [segments[i] for i in segment_indices],
                         'attribution': 'unverified-ASR-candidate'}
        if not _time(matched_start) or not _time(matched_end) or matched_end <= matched_start:
            reasons.append('missing-or-invalid-matched-boundaries')
        reasons = list(dict.fromkeys(reasons))
        def boundary_range(matched, possible):
            return {'lower': min(matched, possible), 'upper': max(matched, possible)} if _time(matched) and _time(possible) else None
        alignment.append({'planned': window, 'actualStart': matched_start, 'actualEnd': matched_end,
                          'matchedStart': matched_start, 'matchedEnd': matched_end,
                          'alignmentCoverage': len(matched_indices) / max(1, count),
                          'firstTokenMatched': first_matched, 'lastTokenMatched': last_matched,
                          'tokenizationVersion': 2, 'tokenizationMethod': 'whole-utterance-context-to-original-word-timestamps',
                          'boundaryEvidenceVersion': 2, 'boundaryStatus': 'uncertain' if reasons else 'reliable',
                          'boundaryUncertaintyReasons': reasons,
                          'utteranceCandidateStart': candidate_start, 'utteranceCandidateEnd': candidate_end,
                          'startBoundaryRange': boundary_range(matched_start, candidate_start),
                          'endBoundaryRange': boundary_range(matched_end, candidate_end),
                          'rawUtteranceCandidate': candidate})
        offset = stop
    return alignment
