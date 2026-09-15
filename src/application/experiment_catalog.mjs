export const EXPERIMENTS = {
  treatment: { name: '五轮协作', description: '5 轮共享观点与完整方案 → R6完善方案 → Chair仅排序' },
  independent: { name: '五轮独立采样', description: '创意席位读取空观点板与空方案池；R6读取全部成果；Chair仅排序' },
  single: { name: '单轮多席位', description: '所有席位独立生成完整方案一次，再由 Chair 排序' },
  direct: { name: '单模型直接回答', description: '使用相同模型配置直接回答一次，不经过 Chair 排序' }
};
