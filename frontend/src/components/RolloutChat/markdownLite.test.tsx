import { render } from '@testing-library/react';
import { renderMarkdownLite } from './markdownLite';

describe('renderMarkdownLite', () => {
  it('passes plain text through as a single unfragmented string', () => {
    const text = 'just plain text\nwith a second line';
    // Identity matters: plain prose must not be fragmented into spans.
    expect(renderMarkdownLite(text)).toBe(text);
  });

  it('renders **bold** as <strong> without the sigils', () => {
    const { container, getByText } = render(<div>{renderMarkdownLite('a **bold** claim')}</div>);
    expect(getByText('bold').tagName).toBe('STRONG');
    expect(container.textContent).not.toContain('**');
    expect(container.textContent).toContain('a ');
    expect(container.textContent).toContain(' claim');
  });

  it('renders `inline code` as <code> without the backticks', () => {
    const { container, getByText } = render(
      <div>{renderMarkdownLite('run `npm test` now')}</div>,
    );
    const code = getByText('npm test');
    expect(code.tagName).toBe('CODE');
    expect(code.className).toContain('font-mono');
    expect(container.textContent).not.toContain('`');
  });

  it('renders a closed ``` fence as a <pre> block', () => {
    const { container } = render(
      <div>{renderMarkdownLite('before\n```py\nprint(1)\n```\nafter')}</div>,
    );
    const pre = container.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toBe('print(1)');
    expect(pre!.className).toContain('font-mono');
    expect(pre!.className).toContain('overflow-x-auto');
    expect(container.textContent).not.toContain('```');
    expect(container.textContent).toContain('before');
    expect(container.textContent).toContain('after');
  });

  it('treats a trailing unterminated fence as an open code block (streaming)', () => {
    const { container } = render(
      <div>{renderMarkdownLite('look:\n```js\nconst x = 1;')}</div>,
    );
    const pre = container.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toBe('const x = 1;');
    expect(container.textContent).not.toContain('```');
  });

  it('renders "- " and "N. " list lines with markers', () => {
    const { container } = render(
      <div>{renderMarkdownLite('- first item\n2. second item\nplain tail')}</div>,
    );
    expect(container.textContent).toContain('• first item');
    expect(container.textContent).toContain('2. second item');
    expect(container.textContent).toContain('plain tail');
    expect(container.textContent).not.toContain('- first');
  });

  it('applies inline formatting inside list lines', () => {
    const { getByText } = render(<div>{renderMarkdownLite('- has **bold** inside')}</div>);
    expect(getByText('bold').tagName).toBe('STRONG');
  });
});
