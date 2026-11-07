import { useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import './kit.css';
import { Button, Checkbox, IconButton, Input, Radio, Select, Table, Textarea } from '.';

// Sample names for the search; a development page, so its texts stay out of the dictionary.
const BRANCHES = ['main', 'develop', ...['oauth-token-refresh', 'sarif-import', 'finding-verify', 'schedule-cron', 'pi-agent', 'module-map'].flatMap((b) => [`feature/${b}`, `fix/${b}`, `release/${b}`])];

function Row({ state, children }: { state: string; children: ReactNode }) {
  return (
    <div className="kit-row">
      <span className="muted small">{state}</span>
      <div className="row">{children}</div>
    </div>
  );
}

function Kit() {
  const [branch, setBranch] = useState('main');
  const [severity, setSeverity] = useState('high');
  const [target, setTarget] = useState('');
  return (
    <main className="kit">
      <h1>aiegis ui kit</h1>

      <h2>Select</h2>
      <Row state="long list, search visible">
        <Select aria-label="Branch" value={branch} onChange={setBranch}>
          {BRANCHES.map((b) => (
            <option key={b}>{b}</option>
          ))}
        </Select>
      </Row>
      <Row state="short list, search on typing">
        <Select aria-label="Severity" value={severity} onChange={setSeverity}>
          {['critical', 'high', 'medium', 'low'].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </Select>
      </Row>
      <Row state="groups, empty choice">
        <Select aria-label="Set or document" value={target} onChange={setTarget}>
          <option value="" />
          <optgroup label="Sets">
            <option value="set:1">OWASP ASVS</option>
            <option value="set:2">Internal baseline</option>
          </optgroup>
          <optgroup label="Documents">
            <option value="doc:1">Session rules</option>
            <option value="doc:2" disabled>
              Retired policy
            </option>
          </optgroup>
        </Select>
      </Row>
      <Row state="disabled">
        <Select aria-label="Disabled" value="main" onChange={() => undefined} disabled>
          <option>main</option>
        </Select>
      </Row>

      <h2>Button</h2>
      <Row state="variants">
        <Button>Default</Button>
        <Button variant="primary">Primary</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="danger">Danger</Button>
        <Button variant="ok">Ok</Button>
      </Row>
      <Row state="disabled, loading, pressed">
        <Button disabled>Disabled</Button>
        <Button variant="primary" loading>
          Running
        </Button>
        <Button aria-pressed>Pressed</Button>
      </Row>
      <Row state="with an icon">
        <IconButton icon="play" title="Run" />
        <IconButton icon="plus" variant="ghost" title="Add" />
        <IconButton icon="close" variant="danger" title="Remove" />
        <IconButton icon="upload" variant="primary" title="Upload" label="Upload" />
        <IconButton icon="upload" title="Upload" label="Uploading" loading />
      </Row>

      <h2>Input</h2>
      <Row state="text, search, date, number">
        <Input placeholder="placeholder" aria-label="Text" />
        <Input type="search" placeholder="search" aria-label="Search" />
        <Input type="date" aria-label="Date" />
        <Input type="number" defaultValue={3} aria-label="Number" />
      </Row>
      <Row state="disabled, read only, invalid">
        <Input disabled defaultValue="disabled" aria-label="Disabled" />
        <Input readOnly defaultValue="read only" aria-label="Read only" />
        <Input aria-invalid defaultValue="invalid" aria-label="Invalid" />
      </Row>
      <Row state="textarea">
        <Textarea rows={2} placeholder="placeholder" aria-label="Notes" />
        <Textarea rows={2} disabled defaultValue="disabled" aria-label="Disabled notes" />
      </Row>
      <Row state="checkbox, radio">
        <label className="check">
          <Checkbox defaultChecked /> On
        </label>
        <label className="check">
          <Checkbox /> Off
        </label>
        <label className="check">
          <Checkbox disabled /> Disabled
        </label>
        <label className="check">
          <Radio name="kit" defaultChecked /> First
        </label>
        <label className="check">
          <Radio name="kit" /> Second
        </label>
      </Row>

      <h2>Table</h2>
      <Table>
        <thead>
          <tr>
            <th>Finding</th>
            <th>Severity</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Row</td>
            <td>
              <span className="status sev-high">high</span>
            </td>
            <td>
              <span className="status fs-suspected">suspected</span>
            </td>
          </tr>
          <tr className="selected">
            <td>Selected row</td>
            <td>
              <span className="status sev-low">low</span>
            </td>
            <td>
              <span className="status fs-fixed">fixed</span>
            </td>
          </tr>
        </tbody>
      </Table>
      <Table compact>
        <tbody>
          <tr>
            <td>Compact row</td>
            <td className="mono">a1b2c3d4</td>
          </tr>
        </tbody>
      </Table>

      <h2>Status and chip</h2>
      <Row state="status">
        <span className="status s-running">running</span>
        <span className="status s-done">done</span>
        <span className="status s-failed">failed</span>
        <span className="status r-rate_limited">rate limited</span>
        <span className="status cs-not_checked">not checked</span>
      </Row>
      <Row state="chip">
        <Button className="chip">Toggle</Button>
        <Button className="chip" aria-pressed>
          Pressed
        </Button>
      </Row>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<Kit />);
