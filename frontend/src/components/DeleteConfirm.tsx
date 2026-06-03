/**
 * components/DeleteConfirm.tsx
 * 删除确认弹窗组件（U-09）
 * - 投票标题预览
 * - 危险色「确认删除」按钮
 * - 遮罩层点击关闭 + ESC 关闭
 */
import { useEffect, useRef } from 'react';
import styles from './DeleteConfirm.module.css';

interface DeleteConfirmProps {
  title: string;
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
}

export default function DeleteConfirm({
  title,
  onConfirm,
  onCancel,
  loading = false,
}: DeleteConfirmProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // ESC 关闭（桌面端）
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !loading) {
        onCancel();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onCancel, loading]);

  // 自动聚焦确认按钮（安全：需再按 Enter 才能触发）
  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  return (
    <div
      className={styles.overlay}
      onClick={loading ? undefined : onCancel}
      role="presentation"
    >
      <div
        className={styles.dialog}
        onClick={(e) => e.stopPropagation()}
        ref={dialogRef}
        role="alertdialog"
        aria-labelledby="delete-dialog-title"
      >
        <div className={styles.iconWrapper}>
          <span className={styles.icon}>⚠️</span>
        </div>
        <p className={styles.title} id="delete-dialog-title">确认删除投票</p>
        <div className={styles.preview}>
          <span className={styles.previewLabel}>投票标题：</span>
          <span className={styles.previewText}>{title}</span>
        </div>
        <p className={styles.hint}>
          删除后数据仍保留在系统内，所有用户将无法再查看和投票。此操作不可撤销。
        </p>
        <div className={styles.actions}>
          <button
            className={styles.cancelBtn}
            onClick={onCancel}
            disabled={loading}
          >
            取消
          </button>
          <button
            className={styles.confirmBtn}
            onClick={onConfirm}
            disabled={loading}
            ref={confirmRef}
          >
            {loading ? '删除中...' : '确认删除'}
          </button>
        </div>
      </div>
    </div>
  );
}
