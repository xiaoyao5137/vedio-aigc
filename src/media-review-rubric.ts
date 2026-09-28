/** Shared semantics for independent and whole-shot visual reviewers. These are
 * evidence rules, not observations or overrides of an actual model report. */
export const MEDIA_REQUIREMENT_SCOPE_RULES = `【原要求的最小解释】
分别核对原文明确约束的躯干、头部、手臂、持物、位置、服饰；未写某属性不等于禁止它。礼貌、平和、恭谨不隐含手势；站立或恢复直立描述躯干，不意味着双手必须放下，也不排斥行礼。兼容状态不能当反证。
拒绝须逐字定位最小原文和该属性的实际相反状态。repair不能破坏同时段其他要求；解释自相矛盾时撤回推断，不擅自丢弃原要求。相邻时段仅供兼容性解释，不产生全程义务。
保持姿态却实际解除是反证；静帧未捕捉短暂点头、欠身、眼神或形成过程，只证明采样限制，不得改称明确相反。确定evidence仅写实见；缺口按evidenceGaps保留unobservable，非关键未知也不能改写成已完成。
手部先看接触与手掌朝向；双前臂水平可与双手胸前合抱并存，不等于向外推掌，不能凭礼仪/武术名称发明手形标准。
服饰身份、时代、显著类别/主色错误须清楚反证；光线、染色、褶皱、束带及非关键装饰微差写warnings。材质需纹理，扁形轮廓不证明布带而非绳；未禁止护腕不等于禁令。外观微差不能冒充持物错误或动作缺失。`;
