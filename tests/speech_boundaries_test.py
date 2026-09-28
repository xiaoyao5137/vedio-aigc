import copy
import json
from pathlib import Path
import re
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from speech_boundaries import align_speech_windows


def sounds(text):
    # Frozen homophones from the real fixture, equivalent to production pinyin.
    # The regression itself needs only stdlib, never downloads/loads a model.
    homophones = {'防': '房', '博': '伯', '殷': '因', '霍': '获', '众': '仲'}
    return [homophones.get(c, c) for c in re.findall(r'[\u3400-\u9fff]', text)]


def segment(text, start=0):
    return {'start': start, 'end': start + len(text), 'text': text,
            'words': [{'word': c, 'start': start + i, 'end': start + i + 1, 'probability': .9} for i, c in enumerate(text)]}


class SpeechBoundariesTest(unittest.TestCase):
    def test_latest_13_of_14_preserves_possible_final_word_without_claiming_it(self):
        fixture = json.loads((Path(__file__).parent / 'fixtures/speech-latest-boundaries.json').read_text())
        original = copy.deepcopy(fixture['segments'])
        row, = align_speech_windows(fixture['segments'], fixture['windows'], sounds)
        self.assertEqual(row['alignmentCoverage'], 13 / 14)
        self.assertEqual(row['matchedStart'], .37)
        self.assertEqual(row['matchedEnd'], 4.99)
        self.assertEqual(row['actualEnd'], 4.99)
        self.assertTrue(row['firstTokenMatched'])
        self.assertFalse(row['lastTokenMatched'])
        self.assertEqual(row['utteranceCandidateEnd'], 5.53)
        self.assertEqual(row['endBoundaryRange'], {'lower': 4.99, 'upper': 5.53})
        self.assertEqual(row['boundaryStatus'], 'uncertain')
        self.assertEqual(row['rawUtteranceCandidate']['words'][-1]['word'], '静')
        self.assertNotIn('好', row['rawUtteranceCandidate']['text'])
        self.assertEqual(row['rawUtteranceCandidate']['attribution'], 'unverified-ASR-candidate')
        self.assertEqual(fixture['segments'], original)

    def test_complete_matching_has_reliable_edges(self):
        row, = align_speech_windows([segment('甲乙丙')], [{'text': '甲乙丙', 'start': 0, 'end': 3}], sounds)
        self.assertEqual(row['boundaryStatus'], 'reliable')
        self.assertEqual(row['startBoundaryRange'], {'lower': 0, 'upper': 0})
        self.assertEqual(row['endBoundaryRange'], {'lower': 3, 'upper': 3})

    def test_missing_tail_never_swallows_next_planned_utterance_in_same_segment(self):
        rows = align_speech_windows([segment('甲乙错丙丁')], [{'text': '甲乙尾'}, {'text': '丙丁'}], sounds)
        self.assertEqual(rows[0]['utteranceCandidateEnd'], 3)
        self.assertEqual(rows[0]['rawUtteranceCandidate']['text'], '甲乙错')
        self.assertEqual(rows[0]['boundaryStatus'], 'uncertain')
        self.assertEqual(rows[1]['matchedStart'], 3)
        self.assertEqual(rows[1]['boundaryStatus'], 'reliable')
        rows = align_speech_windows([segment('甲乙丙丁')], [{'text': '甲乙尾'}, {'text': '丙丁'}], sounds)
        self.assertEqual(rows[0]['utteranceCandidateEnd'], 2)
        self.assertEqual(rows[0]['rawUtteranceCandidate']['text'], '甲乙')
        self.assertEqual(rows[1]['boundaryStatus'], 'reliable')

    def test_word_segment_time_disagreement_stays_uncertain(self):
        raw = segment('甲乙')
        raw['end'] = 2.4
        row, = align_speech_windows([raw], [{'text': '甲乙'}], sounds)
        self.assertTrue(row['lastTokenMatched'])
        self.assertEqual(row['matchedEnd'], 2)
        self.assertEqual(row['utteranceCandidateEnd'], 2.4)
        self.assertEqual(row['boundaryStatus'], 'uncertain')
        self.assertIn('segment-word-end-disagreement', row['boundaryUncertaintyReasons'])

    def test_no_words_or_nonlexical_voice_needs_audio_review(self):
        rows = align_speech_windows([], [{'text': ''}, {'text': '甲乙'}], sounds)
        self.assertTrue(all(row['boundaryStatus'] == 'uncertain' for row in rows))
        self.assertIn('nonlexical-vocalization-needs-audio-review', rows[0]['boundaryUncertaintyReasons'])
        self.assertIsNone(rows[1]['matchedEnd'])

    def test_repeated_leader_and_crowd_line_need_distinct_recognized_tokens(self):
        windows = [{'text': '黄天当立', 'actorIds': ['leader']}, {'text': '黄天当立', 'actorIds': ['crowd']}]
        rows = align_speech_windows([segment('黄天当立')], windows, sounds)
        self.assertEqual(sum(row['alignmentCoverage'] == 1 for row in rows), 1)
        self.assertEqual(sum(row['boundaryStatus'] == 'reliable' for row in rows), 1)
        complete = align_speech_windows([segment('黄天当立'), segment('黄天当立', 4)], windows, sounds)
        self.assertTrue(all(row['boundaryStatus'] == 'reliable' for row in complete))
        self.assertLessEqual(complete[0]['matchedEnd'], complete[1]['matchedStart'])

    def test_contextual_reading_is_computed_before_mapping_original_word_times(self):
        def contextual(text):
            defaults = {'银': 'yin', '行': 'xing'}
            return [('hang' if c == '行' and i > 0 and text[i - 1] == '银' else defaults.get(c, c)) for i, c in enumerate(text)]
        source = segment('银行', 2)
        before = copy.deepcopy(source)
        row, = align_speech_windows([source], [{'text': '银行'}], contextual)
        self.assertEqual(row['alignmentCoverage'], 1)
        self.assertEqual(row['boundaryStatus'], 'reliable')
        self.assertEqual((row['matchedStart'], row['matchedEnd']), (2, 4))
        self.assertEqual(row['rawUtteranceCandidate']['words'], source['words'])
        self.assertEqual(source, before)

    def test_context_token_cardinality_or_word_text_disagreement_cannot_invent_reliable_edges(self):
        source = segment('银行')
        row, = align_speech_windows([source], [{'text': '银行'}], lambda text: ['combined'] if text else [])
        self.assertEqual(row['boundaryStatus'], 'uncertain')
        self.assertIsNone(row['matchedStart'])
        self.assertIn('contextual-token-count-mismatch', row['boundaryUncertaintyReasons'])
        source['text'] = '甲乙'
        row, = align_speech_windows([source], [{'text': '银行'}], sounds)
        self.assertEqual(row['boundaryStatus'], 'uncertain')
        self.assertIn('segment-word-text-disagreement', row['boundaryUncertaintyReasons'])

    def test_a_multicharacter_asr_word_cannot_supply_invented_internal_word_boundaries(self):
        source = {'start': 1, 'end': 3, 'text': '甲乙', 'words': [{'word': '甲乙', 'start': 1, 'end': 3, 'probability': .99}]}
        whole, = align_speech_windows([source], [{'text': '甲乙'}], sounds)
        self.assertEqual(whole['boundaryStatus'], 'reliable')
        split = align_speech_windows([source], [{'text': '甲'}, {'text': '乙'}], sounds)
        self.assertTrue(all(row['boundaryStatus'] == 'uncertain' for row in split))
        self.assertTrue(all('planned-boundary-inside-asr-word' in row['boundaryUncertaintyReasons'] for row in split))

    def test_module_does_not_initialize_asr(self):
        self.assertNotIn('faster_whisper', sys.modules)
        self.assertNotIn('pypinyin', sys.modules)


if __name__ == '__main__':
    unittest.main()
