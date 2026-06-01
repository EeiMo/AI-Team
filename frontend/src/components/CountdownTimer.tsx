/**
 * components/CountdownTimer.tsx
 * 倒计时组件：根据剩余秒数切换视觉状态
 * - 正常：灰色文案 "剩余 12:30"
 * - ≤60s：红色 + CSS 脉冲动画
 * - ≤10s：大号红色闪烁
 * - 归零：回调 onExpire
 */
import { useState, useEffect, useRef } from 'react';
import styles from './CountdownTimer.module.css';

interface CountdownTimerProps {
  deadline: string;     // ISO 时间戳
  onExpire?: () => void;
}

export default function CountdownTimer({ deadline, onExpire }: CountdownTimerProps) {
  const [remaining, setRemaining] = useState(0);
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;

  useEffect(() => {
    const calcRemaining = () => {
      const now = Date.now();
      const end = new Date(deadline).getTime();
      return Math.max(0, Math.floor((end - now) / 1000));
    };

    setRemaining(calcRemaining());

    const timer = setInterval(() => {
      const r = calcRemaining();
      setRemaining(r);
      if (r <= 0) {
        clearInterval(timer);
        onExpireRef.current?.();
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [deadline]);

  const isWarning = remaining <= 60 && remaining > 10;
  const isCritical = remaining <= 10 && remaining > 0;
  const isExpired = remaining <= 0;

  // 格式化 mm:ss
  const format = (seconds: number): string => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  if (isExpired) {
    return <span className={styles.expired}>已结束</span>;
  }

  return (
    <span
      className={`${styles.timer} ${isWarning ? styles.warning : ''} ${isCritical ? styles.critical : ''}`}
    >
      剩余 {format(remaining)}
    </span>
  );
}
