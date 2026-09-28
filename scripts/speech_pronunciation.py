"""Text-derived pronunciation clues, never an acoustic pronunciation verdict.

Tokenizers are supplied by the caller; importing this module loads no model or
dictionary. Tone differences below are dictionary readings of ASR characters.
"""
import re
from difflib import SequenceMatcher


def assess_pronunciation_text(expected, recognized, syllables, lexical_tones):
    left_text = ''.join(re.findall(r'[\u3400-\u9fff]', expected))
    right_text = ''.join(re.findall(r'[\u3400-\u9fff]', recognized))
    left, right = syllables(left_text), syllables(right_text)
    left_tones, right_tones = lexical_tones(left_text), lexical_tones(right_text)
    costs = list(range(len(right) + 1))
    for i, source in enumerate(left, 1):
        next_costs = [i]
        for j, target in enumerate(right, 1):
            next_costs.append(min(next_costs[-1] + 1, costs[j] + 1, costs[j - 1] + (source != target)))
        costs = next_costs
    variants = []
    if len(left) == len(left_text) == len(left_tones) and len(right) == len(right_text) == len(right_tones):
        for block in SequenceMatcher(None, left, right, autojunk=False).get_matching_blocks():
            for offset in range(block.size):
                a, b = block.a + offset, block.b + offset
                if left_text[a] != right_text[b]:
                    variants.append({'expectedIndex': a, 'recognizedIndex': b, 'expectedText': left_text[a], 'recognizedText': right_text[b],
                                     'syllable': left[a], 'expectedLexicalPinyin': left_tones[a], 'recognizedLexicalPinyin': right_tones[b],
                                     'kind': 'same-syllable-different-lexical-tone' if left_tones[a] != right_tones[b] else 'same-syllable-different-text'})
    warnings = []
    for kind, code, problem in [
        ('same-syllable-different-lexical-tone', 'asr_lexical_tone_variant', '原文与 ASR 同音节异调字转写存在疑点；声调来自文字词典推导，尚未实测真实发音。'),
        ('same-syllable-different-text', 'asr_homophone_spelling_variant', '原文与 ASR 存在同音字形差异；仅作为转写疑点，不能据此断言错音。'),
    ]:
        matching = [variant for variant in variants if variant['kind'] == kind]
        if matching:
            warnings.append({'code': code, 'problem': problem, 'evidence': {'source': 'asr-text-dictionary', 'variants': matching},
                             'repair': '保留原字与原媒体，复核同一音轨对应词的真实声调和读音；不得用同音替字改写台词。'})
    return {'version': 'pronunciation-assessment-v1', 'status': 'unverified', 'evidenceLevel': 'asr-text-only',
            'toneVerified': False, 'phonemeVerified': False, 'metricKind': 'toneless-asr-text-syllable-edit-distance',
            'syllableTextErrorRate': costs[-1] / max(1, len(left)), 'legacyMetricField': 'phoneticErrorRate',
            'toneComparisonSource': 'dictionary-derived-from-text-not-measured-audio',
            'expectedSyllables': left, 'recognizedSyllables': right, 'transcriptionVariants': variants, 'warnings': warnings}
