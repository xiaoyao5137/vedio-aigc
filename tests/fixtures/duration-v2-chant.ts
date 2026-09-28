import { DEFAULT_DURATION_POLICY } from '../../src/duration-policy.ts'
import type { DurationBeat } from '../../src/duration-schedule.ts'

export const songText = '天下规矩房伯武,因师获印周仲进'
export const chantScene = {id:'scene-01',targetDuration:8,requiredBeats:[{id:'song-spreads',
  mustShow:[songText,'围观乡人点头'],description:'歌谣原文唱出，围观乡人回应',setting:'甘陵街巷'}]}
export function chantShot() {
  const beats: DurationBeat[] = [
    {id:'opening',sourceBeatId:'song-spreads',actorIds:['传唱歌谣的乡人'],kind:'action',textOrVocalization:'传唱歌谣的乡人行走于甘陵街巷，进入人群可听见的位置',
      dependsOn:[],overlapAllowedWith:[],durationEstimate:{lower:.8,expected:.8,upper:.8,source:'已批准开场建立估计',confidence:'low'},
      completion:{requiredThisClip:true,finalState:'乡人进入有效表演位置',modality:'visual',evidenceAnchor:'行走于甘陵街巷'}},
    {id:'lead-song',sourceBeatId:'song-spreads',actorIds:['传唱歌谣的乡人'],kind:'speech',deliveryStyle:'chant',textOrVocalization:songText,
      dependsOn:['opening'],overlapAllowedWith:[],durationEstimate:{lower:3.3,expected:4.4,upper:5.5,source:'record-4kibh7 原始ASR候选跨度5.16秒，待听音校准的保守估计',confidence:'low'},
      completion:{requiredThisClip:true,finalState:'主唱完整唱出歌谣末字',modality:'audio-visual',evidenceAnchor:songText}},
    {id:'crowd-response',sourceBeatId:'song-spreads',actorIds:['listeners'],kind:'vocalization',textOrVocalization:'围观乡人点头并作一次短促无词哼唱回应',
      dependsOn:['lead-song'],overlapAllowedWith:[],durationEstimate:{lower:1.5,expected:1.6,upper:1.8,source:'群体短促回应导演估计，待实际声画验证',confidence:'low'},
      completion:{requiredThisClip:true,finalState:'群众点头过程与可听哼唱回应结束',modality:'audio-visual',evidenceAnchor:'围观乡人点头'},
      vocalization:{vocalizationType:'哼唱',actorGroup:'listeners',expectedAudibility:'明确可听的群体声音',melodyRelation:'与主唱同一曲调的短促回应',completionCue:'短促群体回应收束'}},
  ]
  return {id:'scene-01',title:'甘陵街巷歌谣传唱',duration:9,coveredBeatIds:['song-spreads'],
    pacing:{version:'duration-v2',timingPolicy:structuredClone(DEFAULT_DURATION_POLICY),beats,
      actorGroups:[{id:'listeners',label:'围观乡人',memberDescription:'街巷中已在场听歌的围观乡人，作为可发声群演'}]},
    characters:['传唱歌谣的乡人'],presentCharacters:['传唱歌谣的乡人'],initialCharacters:['传唱歌谣的乡人'],enteringCharacters:[],endCharacters:['传唱歌谣的乡人'],
    visualPrompt:'传唱歌谣的乡人行走于甘陵街巷，街旁乡人已在场',lastFramePrompt:'传唱歌谣的乡人在围观乡人附近自然站立',
    videoPrompt:'',audioType:'对白',audioText:'传唱歌谣的乡人:'+songText,camera:'中景跟随',mood:'自然',firstFrameMode:'reference',
    continuity:{previousShotId:'',bridgeType:'opening',bridgeAnchor:''},historicalBasis:'[史料1] 天下规矩房伯武，因师获印周仲进',adaptationBoundary:'群众短促无词回应为导演假设，待审核'}
}

/** Exact duration-bearing fields from record-4kibh7; no media URLs or private
 * provider payload is needed for the permanent offline regression. */
export const realSixSecondPlanning = {audioText:'传唱歌谣的乡人:'+songText,
  pacing:{version:'dynamic-v1',actionSeconds:1,reactionSeconds:.7,activityWindows:[
    {kind:'action',startSecond:0,endSecond:1},{kind:'speech',startSecond:1,endSecond:4.3},{kind:'reaction',startSecond:4.3,endSecond:5}]},
  duration:6,plannedDuration:8,actualDuration:6.04,asrAlignedSpan:4.62,asrCoverage:13/14,asrAllSpeechEnd:5.83}
