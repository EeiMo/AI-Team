/**
 * pages/CreateVote.tsx
 * 创建投票表单页：标题、选项动态增删、投票设置、表单校验
 *
 * 对应 PRD §5.2：
 * - 标题 100 字限制 + 实时计数
 * - 选项 2-10 个，动态增删，不可重复
 * - 投票类型（单选/多选）、投票模式（匿名/实名）分段控制器
 * - 截止时间预设 + 自定义分钟数
 * - 底部固定操作栏（取消 + 发布）
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCreateVote } from '../hooks/useCreateVote';
import styles from './CreateVote.module.css';
import type { VoteType, VoteMode } from '../types';

export default function CreateVote() {
  const navigate = useNavigate();
  const {
    form,
    submitting,
    errors,
    serverError,
    deadlinePresets,
    isValid,
    setTitle,
    setOption,
    addOption,
    removeOption,
    setVoteType,
    setVoteMode,
    setDeadline,
    setTotalVoters,
    submit,
  } = useCreateVote();

  // 自定义截止时间输入模态框
  const [showCustomDeadline, setShowCustomDeadline] = useState(false);
  const [customDeadlineValue, setCustomDeadlineValue] = useState('');
  const [customDeadlineError, setCustomDeadlineError] = useState('');

  // 获取字段错误
  const getFieldError = (field: string) => errors.find((e) => e.field === field)?.message;
  const titleError = getFieldError('title');
  const optionsError = getFieldError('options');

  const handleSubmit = async () => {
    const voteId = await submit();
    if (voteId) {
      navigate(`/votes/${voteId}`, { replace: true });
    }
  };

  // 自定义截止时间确认
  const handleCustomDeadlineConfirm = () => {
    const num = Number(customDeadlineValue);
    if (!Number.isFinite(num) || num < 1 || num > 10080 || !Number.isInteger(num)) {
      setCustomDeadlineError('请输入 1-10080 之间的整数');
      return;
    }
    setDeadline(num);
    setShowCustomDeadline(false);
    setCustomDeadlineValue('');
    setCustomDeadlineError('');
  };

  const openCustomDeadline = () => {
    setCustomDeadlineValue('');
    setCustomDeadlineError('');
    setShowCustomDeadline(true);
  };

  return (
    <div className={styles.page}>
      {/* 顶部 */}
      <header className={styles.header}>
        <button className={styles.backBtn} onClick={() => navigate(-1)}>
          ← 返回
        </button>
        <h1 className={styles.heading}>发起投票</h1>
      </header>

      <main className={styles.form}>
        {/* 1. 投票标题 */}
        <div className={styles.field}>
          <label className={styles.label}>投票标题 <span className={styles.required}>*</span></label>
          <input
            className={`${styles.input} ${titleError ? styles.inputError : ''}`}
            type="text"
            placeholder="输入投票主题，如：Sprint 24 团建去哪儿？"
            value={form.title}
            onChange={(e) => setTitle(e.target.value.slice(0, 100))}
            maxLength={100}
          />
          <div className={styles.fieldFooter}>
            {titleError && <span className={styles.errorText}>{titleError}</span>}
            <span className={styles.counter}>{form.title.length}/100</span>
          </div>
        </div>

        {/* 2. 选项列表 */}
        <div className={styles.field}>
          <label className={styles.label}>选项 <span className={styles.required}>*</span></label>
          {form.options.map((opt, i) => {
            const optError = getFieldError(`option_${i}`);
            return (
              <div key={i} className={styles.optionRow}>
                <input
                  className={`${styles.input} ${styles.optionInput} ${optError ? styles.inputError : ''}`}
                  type="text"
                  placeholder={`选项 ${i + 1}`}
                  value={opt}
                  onChange={(e) => setOption(i, e.target.value.slice(0, 50))}
                  maxLength={50}
                />
                {form.options.length > 2 && (
                  <button
                    className={styles.removeBtn}
                    onClick={() => removeOption(i)}
                    aria-label={`删除选项 ${i + 1}`}
                  >
                    ✕
                  </button>
                )}
                {optError && <span className={styles.optionError}>{optError}</span>}
              </div>
            );
          })}
          {form.options.length < 10 && (
            <button className={styles.addBtn} onClick={addOption}>
              + 添加选项
            </button>
          )}
          {optionsError && (
            <span className={styles.errorText}>{optionsError}</span>
          )}
        </div>

        {/* 3. 投票设置 */}
        <div className={styles.settings}>
          {/* 投票类型 */}
          <div className={styles.field}>
            <label className={styles.label}>投票类型</label>
            <div className={styles.segment}>
              {(['single', 'multi'] as VoteType[]).map((t) => (
                <button
                  key={t}
                  className={`${styles.segBtn} ${form.vote_type === t ? styles.segActive : ''}`}
                  onClick={() => setVoteType(t)}
                >
                  {t === 'single' ? '单选' : '多选'}
                </button>
              ))}
            </div>
            {form.vote_type === 'multi' && (
              <p className={styles.hint}>参与者可选择多个选项</p>
            )}
          </div>

          {/* 投票模式 */}
          <div className={styles.field}>
            <label className={styles.label}>投票模式</label>
            <div className={styles.segment}>
              {(['anonymous', 'public'] as VoteMode[]).map((m) => (
                <button
                  key={m}
                  className={`${styles.segBtn} ${form.vote_mode === m ? styles.segActive : ''}`}
                  onClick={() => setVoteMode(m)}
                >
                  {m === 'anonymous' ? '匿名' : '实名'}
                </button>
              ))}
            </div>
            {form.vote_mode === 'anonymous' && (
              <div className={styles.privacyBanner}>
                📌 匿名投票下，其他参与者看不到你的身份，但系统会记录你的投票以防重复提交
              </div>
            )}
          </div>

          {/* 截止时间 */}
          <div className={styles.field}>
            <label className={styles.label}>截止时间</label>
            <div className={styles.deadlineGrid}>
              {deadlinePresets.map((m) => (
                <button
                  key={m}
                  className={`${styles.deadlineBtn} ${form.deadline_minutes === m ? styles.deadlineActive : ''}`}
                  onClick={() => setDeadline(m)}
                >
                  {m < 60 ? `${m}分钟` : `${m / 60}小时`}
                </button>
              ))}
              <button
                className={`${styles.deadlineBtn} ${!deadlinePresets.includes(form.deadline_minutes) ? styles.deadlineActive : ''}`}
                onClick={openCustomDeadline}
              >
                自定义
              </button>
            </div>
            {!deadlinePresets.includes(form.deadline_minutes) && (
              <p className={styles.hint}>当前：{form.deadline_minutes} 分钟</p>
            )}
          </div>

          {/* 预期投票人数 */}
          <div className={styles.field}>
            <label className={styles.label}>预期投票人数</label>
            <p className={styles.hint} style={{ marginBottom: 8 }}>留空或填 0 表示不限制，不显示进度条</p>
            <input
              className={styles.input}
              type="number"
              inputMode="numeric"
              min={0}
              max={999}
              step={1}
              placeholder="例如 24"
              value={form.total_voters > 0 ? form.total_voters : ''}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                setTotalVoters(Number.isFinite(n) && n >= 0 ? n : 0);
              }}
            />
          </div>
        </div>
      </main>

      {/* 服务端错误 */}
      {serverError && (
        <div className={styles.serverError}>{serverError}</div>
      )}

      {/* 底部操作栏 */}
      <footer className={styles.footer}>
        <button className={styles.cancelBtn} onClick={() => navigate('/votes')}>
          取消
        </button>
        <button
          className={`${styles.submitBtn} ${!isValid || submitting ? styles.submitDisabled : ''}`}
          disabled={!isValid || submitting}
          onClick={handleSubmit}
        >
          {submitting ? '发布中...' : '发布投票'}
        </button>
      </footer>

      {/* 自定义截止时间输入弹窗 */}
      {showCustomDeadline && (
        <div className={styles.overlay} onClick={() => setShowCustomDeadline(false)}>
          <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
            <p className={styles.dialogTitle}>自定义截止时间</p>
            <p className={styles.dialogHint}>请输入分钟数（1-10080）</p>
            <input
              className={`${styles.input} ${customDeadlineError ? styles.inputError : ''}`}
              type="number"
              inputMode="numeric"
              min={1}
              max={10080}
              step={1}
              placeholder="例如 90"
              value={customDeadlineValue}
              onChange={(e) => {
                setCustomDeadlineValue(e.target.value);
                setCustomDeadlineError('');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCustomDeadlineConfirm();
              }}
              autoFocus
            />
            {customDeadlineError && <p className={styles.errorText}>{customDeadlineError}</p>}
            <div className={styles.dialogActions}>
              <button className={styles.dialogCancel} onClick={() => setShowCustomDeadline(false)}>
                取消
              </button>
              <button className={styles.dialogConfirm} onClick={handleCustomDeadlineConfirm}>
                确认
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
