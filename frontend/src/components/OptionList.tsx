/**
 * components/OptionList.tsx
 * 选项列表：单选/多选交互、已选高亮、锁定只读态
 *
 * Props:
 * - options: 选项数组（含 id / content / count）
 * - voteType: 'single' | 'multi'
 * - selected: 已选中的 option_id 集合（由父组件维护）
 * - onToggle: 选中/取消选中回调
 * - disabled: true=只读态（已投票或已结束）
 */
import type { Option as OptionType, VoteType } from '../types';
import styles from './OptionList.module.css';

interface OptionListProps {
  options: OptionType[];
  voteType: VoteType;
  selected: Set<string>;
  onToggle: (optionId: string) => void;
  disabled: boolean;
}

export default function OptionList({
  options,
  voteType,
  selected,
  onToggle,
  disabled,
}: OptionListProps) {
  const isSingle = voteType === 'single';

  const handleClick = (optionId: string) => {
    if (disabled) return;
    if (isSingle) {
      // 单选：取消旧的，选中新的（或反选取消）
      if (selected.has(optionId)) {
        onToggle(optionId); // 反选
      } else {
        // 清除其他选中 + 选中当前
        selected.forEach((id) => onToggle(id));
        onToggle(optionId);
      }
    } else {
      onToggle(optionId);
    }
  };

  return (
    <div className={styles.list}>
      {options.map((opt) => {
        const isSelected = selected.has(opt.id);
        return (
          <div
            key={opt.id}
            className={`${styles.option} ${isSelected ? styles.selected : ''} ${disabled ? styles.disabled : ''}`}
            onClick={() => handleClick(opt.id)}
            role={isSingle ? 'radio' : 'checkbox'}
            aria-checked={isSelected}
            tabIndex={disabled ? -1 : 0}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleClick(opt.id); }}
          >
            {/* 选择指示器 */}
            <span className={`${styles.indicator} ${isSingle ? styles.radio : styles.checkbox}`}>
              {isSelected && (
                isSingle
                  ? <span className={styles.radioDot} />
                  : <span className={styles.checkMark}>✓</span>
              )}
            </span>
            {/* 选项文案 */}
            <span className={styles.content}>{opt.content}</span>
          </div>
        );
      })}
    </div>
  );
}
