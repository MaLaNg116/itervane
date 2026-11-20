// Adapted from the shadcn/ui Base UI table. See public/shadcn-LICENSE.txt.
import type { ComponentProps } from 'react';
import { cn } from './cn.js';

export function Table({ label, className, ...props }: ComponentProps<'table'> & { label: string }) {
  return <div data-slot="table-container" className="table-scroll" role="region" aria-label={label} tabIndex={0}>
    <table data-slot="table" aria-label={label} className={cn('w-full min-w-[37rem] border-collapse text-sm', className)} {...props} />
  </div>;
}
