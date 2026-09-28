from pathlib import Path
import re
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from speech_pronunciation import assess_pronunciation_text

# Explicit fixture readings test metadata semantics without loading a dictionary
# or acoustic model. They are not a claim about the sound of any actual clip.
READINGS = {'渠': 'qu2', '去': 'qu4', '帅': 'shuai4', '黄': 'huang2', '皇': 'huang2', '天': 'tian1'}
tones = lambda text: [READINGS.get(c, c) for c in text]
syllables = lambda text: [re.sub(r'\d$', '', sound) for sound in tones(text)]


class PronunciationTextTest(unittest.TestCase):
    def test_zero_toneless_text_distance_never_verifies_actual_tone(self):
        proof = assess_pronunciation_text('渠帅', '去帅', syllables, tones)
        self.assertEqual(proof['syllableTextErrorRate'], 0)
        self.assertEqual(proof['status'], 'unverified')
        self.assertEqual(proof['evidenceLevel'], 'asr-text-only')
        self.assertFalse(proof['toneVerified'])
        self.assertFalse(proof['phonemeVerified'])
        self.assertEqual(proof['transcriptionVariants'][0]['kind'], 'same-syllable-different-lexical-tone')
        self.assertEqual(proof['warnings'][0]['code'], 'asr_lexical_tone_variant')

    def test_homophone_and_same_text_never_become_acoustic_pronunciation_proof(self):
        proof = assess_pronunciation_text('黄天', '皇天', syllables, tones)
        self.assertEqual(proof['warnings'][0]['code'], 'asr_homophone_spelling_variant')
        self.assertEqual(proof['syllableTextErrorRate'], 0)
        exact = assess_pronunciation_text('渠帅', '渠帅', syllables, tones)
        self.assertEqual(exact['warnings'], [])
        self.assertFalse(exact['toneVerified'])
        self.assertFalse(exact['phonemeVerified'])

    def test_empty_or_missing_text_and_malformed_token_count_never_invent_tone_variants(self):
        empty = assess_pronunciation_text('渠帅', '', syllables, tones)
        self.assertEqual(empty['syllableTextErrorRate'], 1)
        self.assertEqual(empty['transcriptionVariants'], [])
        malformed = assess_pronunciation_text('渠帅', '去帅', lambda text: ['one'], tones)
        self.assertEqual(malformed['transcriptionVariants'], [])
        self.assertFalse(malformed['toneVerified'])


if __name__ == '__main__':
    unittest.main()
