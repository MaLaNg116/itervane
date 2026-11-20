// Adapted from the shadcn/ui Base UI registry. See public/shadcn-LICENSE.txt.
import type { ComponentProps } from 'react';
import { cn } from './cn.js';

export function Card({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="card" className={cn('min-w-0 rounded-xl border border-solid border-border bg-card text-foreground', className)} {...props} />;
}

export function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="card-header" className={cn('flex flex-wrap items-center justify-between gap-3 border-b border-solid border-border px-5 py-4 sm:px-6', className)} {...props} />;
}

export function CardTitle({ className, ...props }: ComponentProps<'h2'>) {
  return <h2 data-slot="card-title" className={cn('m-0 text-base font-semibold', className)} {...props} />;
}

export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="card-content" className={cn('min-w-0 p-5 sm:p-6', className)} {...props} />;
}
