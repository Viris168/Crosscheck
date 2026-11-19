// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { InstallAppButton } from './install-app-button';

afterEach(cleanup);

describe('InstallAppButton', () => {
  it("links to GitHub's install page in a new tab", () => {
    render(<InstallAppButton href="https://github.com/apps/x/installations/new" />);
    const link = screen.getByRole('link', { name: /Install GitHub App/ });
    expect(link.getAttribute('href')).toBe('https://github.com/apps/x/installations/new');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('renders nothing without a URL', () => {
    const { container } = render(<InstallAppButton href={null} />);
    expect(container.innerHTML).toBe('');
  });
});
