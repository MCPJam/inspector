'use client';

import { ReactNode } from 'react';
import { clsx } from 'clsx';

interface TabsProps {
  children: ReactNode;
  value: string;
  onValueChange: (value: string) => void;
  className?: string;
}

interface TabsListProps {
  children: ReactNode;
  className?: string;
}

interface TabsTriggerProps {
  children: ReactNode;
  value: string;
  className?: string;
}

interface TabsContentProps {
  children: ReactNode;
  value: string;
  className?: string;
}

export function Tabs({ children, value, onValueChange, className }: TabsProps) {
  return (
    <div className={clsx('w-full', className)} data-value={value} data-onvaluechange={onValueChange}>
      {children}
    </div>
  );
}

export function TabsList({ children, className }: TabsListProps) {
  return (
    <div className={clsx('flex h-10 items-center justify-center rounded-md bg-gray-100 p-1', className)}>
      {children}
    </div>
  );
}

export function TabsTrigger({ children, value, className }: TabsTriggerProps) {
  return (
    <button
      className={clsx(
        'inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium ring-offset-white transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-white data-[state=active]:text-gray-950 data-[state=active]:shadow-sm',
        className
      )}
      data-value={value}
    >
      {children}
    </button>
  );
}

export function TabsContent({ children, value, className }: TabsContentProps) {
  return (
    <div className={clsx('mt-2 ring-offset-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2', className)} data-value={value}>
      {children}
    </div>
  );
}