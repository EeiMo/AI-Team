/**
 * hooks/useCreateVote.ts
 * 创建投票 Hook：表单状态管理、校验、提交
 */
import { useState, useCallback, useMemo } from 'react';
import api from '../services/api';
import type { ApiResponse, CreateVoteResponse, CreateVoteRequest, VoteType, VoteMode, ValidationError } from '../types';

interface FormState {
  title: string;
  options: string[];
  vote_type: VoteType;
  vote_mode: VoteMode;
  deadline_minutes: number;
  total_voters: number;
}

const DEADLINE_PRESETS = [5, 15, 30, 60];

const INITIAL_FORM: FormState = {
  title: '',
  options: ['', ''],
  vote_type: 'single',
  vote_mode: 'anonymous',
  deadline_minutes: 30,
  total_voters: 0,
};

export function useCreateVote() {
  const [form, setForm] = useState<FormState>({ ...INITIAL_FORM, options: ['', ''] });
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<ValidationError[]>([]);
  const [serverError, setServerError] = useState<string | null>(null);

  // ---- 表单字段更新 ----
  const setTitle = useCallback((title: string) => {
    setForm((prev) => ({ ...prev, title }));
    setErrors((prev) => prev.filter((e) => e.field !== 'title'));
  }, []);

  const setOption = useCallback((index: number, value: string) => {
    setForm((prev) => {
      const opts = [...prev.options];
      opts[index] = value;
      return { ...prev, options: opts };
    });
    setErrors((prev) => prev.filter((e) => e.field !== `option_${index}` && e.field !== 'options'));
  }, []);

  const addOption = useCallback(() => {
    setForm((prev) => {
      if (prev.options.length >= 10) return prev;
      return { ...prev, options: [...prev.options, ''] };
    });
  }, []);

  const removeOption = useCallback((index: number) => {
    setForm((prev) => {
      if (prev.options.length <= 2) return prev;
      const opts = prev.options.filter((_, i) => i !== index);
      return { ...prev, options: opts };
    });
    setErrors((prev) => prev.filter((e) => e.field !== `option_${index}`));
  }, []);

  const setVoteType = useCallback((t: VoteType) => setForm((prev) => ({ ...prev, vote_type: t })), []);
  const setVoteMode = useCallback((m: VoteMode) => setForm((prev) => ({ ...prev, vote_mode: m })), []);
  const setDeadline = useCallback((m: number) => setForm((prev) => ({ ...prev, deadline_minutes: m })), []);
  const setTotalVoters = useCallback((n: number) => setForm((prev) => ({ ...prev, total_voters: n })), []);

  // ---- 表单校验 ----
  const validate = useCallback((): ValidationError[] => {
    const errs: ValidationError[] = [];
    const trimmedTitle = form.title.trim();

    if (!trimmedTitle) {
      errs.push({ field: 'title', message: '请填写投票标题' });
    } else if (trimmedTitle.length > 100) {
      errs.push({ field: 'title', message: '标题不能超过 100 字' });
    }

    const nonEmptyOptions = form.options.map((o) => o.trim()).filter(Boolean);
    if (nonEmptyOptions.length < 2) {
      errs.push({ field: 'options', message: '至少需要 2 个选项' });
    }

    // 检查重复
    const seen = new Set<string>();
    form.options.forEach((opt, i) => {
      const trimmed = opt.trim();
      if (!trimmed) {
        errs.push({ field: `option_${i}`, message: '请填写选项内容' });
      } else if (trimmed.length > 50) {
        errs.push({ field: `option_${i}`, message: '选项不能超过 50 字' });
      } else if (seen.has(trimmed)) {
        errs.push({ field: `option_${i}`, message: '选项不可重复' });
      } else {
        seen.add(trimmed);
      }
    });

    if (form.deadline_minutes < 1 || form.deadline_minutes > 10080) {
      errs.push({ field: 'deadline', message: '截止时间须在 1-10080 分钟之间' });
    }

    return errs;
  }, [form]);

  // ---- 提交 ----
  const submit = useCallback(async (): Promise<string | null> => {
    const errs = validate();
    setErrors(errs);
    if (errs.length > 0) return null;

    setSubmitting(true);
    setServerError(null);

    try {
      const payload: CreateVoteRequest = {
        title: form.title.trim(),
        options: form.options.map((o) => o.trim()).filter(Boolean),
        vote_type: form.vote_type,
        vote_mode: form.vote_mode,
        deadline_minutes: form.deadline_minutes,
        total_voters: form.total_voters > 0 ? form.total_voters : undefined,
      };
      const res = await api.post<ApiResponse<CreateVoteResponse>>('/votes', payload);
      return res.data.data!.vote.id;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '网络异常，请稍后重试';
      setServerError(msg);
      return null;
    } finally {
      setSubmitting(false);
    }
  }, [form, validate]);

  // ---- 表单有效性 ----
  const isValid = useMemo(() => {
    const trimmedTitle = form.title.trim();
    if (!trimmedTitle) return false;
    const nonEmpty = form.options.filter((o) => o.trim()).length;
    if (nonEmpty < 2) return false;
    const uniqueOpts = new Set(form.options.map((o) => o.trim()).filter(Boolean));
    if (uniqueOpts.size !== nonEmpty) return false;
    return true;
  }, [form]);

  return {
    form,
    submitting,
    errors,
    serverError,
    deadlinePresets: DEADLINE_PRESETS,
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
  };
}
