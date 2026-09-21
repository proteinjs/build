import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { estate } from '../src/estate';
import { EstateRegistry } from '../src/EstateRegistry';

/**
 * The `estate` CLI is the door launch scripts register through, so a hold has to make the whole
 * trip through it: `register --holds=…` writes it on the row, `list --json` shows it (what a
 * launcher reads back to prove its row carries the hold), and `release` / `hold` change it one
 * label at a time. Asserted as OUTCOMES: the rows on disk under a throwaway estate home.
 */
describe('estate CLI — holds', () => {
  let home: string;
  let previousArgv: string[];

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'estate-cli-holds-'));
    // The CLI builds its registry on the default estate home: point that at the throwaway one.
    jest.spyOn(EstateRegistry, 'home').mockReturnValue(home);
    previousArgv = process.argv;
  });

  afterEach(async () => {
    process.argv = previousArgv;
    jest.restoreAllMocks();
    await fs.rm(home, { recursive: true, force: true });
  });

  const run = async (...args: string[]) => {
    process.argv = ['node', 'estate', ...args];
    await estate();
  };

  test('register --holds writes the holds on the row; list --json prints them; release and hold change one label at a time', async () => {
    await run('register', '--id=lane-held', '--owner=lane-held', '--holds=leased-machines,open-tunnels');
    const registry = new EstateRegistry(home);
    expect((await registry.get('lane-held'))!.holds).toEqual(['leased-machines', 'open-tunnels']);

    const printed: string[] = [];
    const log = jest.spyOn(console, 'log').mockImplementation((line: string) => {
      printed.push(String(line));
    });
    try {
      await run('list', '--json');
    } finally {
      log.mockRestore();
    }
    expect(JSON.parse(printed.join('\n')).estates[0].holds).toEqual(['leased-machines', 'open-tunnels']);

    await run('release', '--id=lane-held', '--hold=leased-machines');
    expect((await registry.get('lane-held'))!.holds).toEqual(['open-tunnels']);

    await run('hold', '--id=lane-held', '--hold=leased-machines');
    expect((await registry.get('lane-held'))!.holds).toEqual(['open-tunnels', 'leased-machines']);
  });

  test('release and hold name what is missing: the label, or a row that does not exist', async () => {
    await run('register', '--id=lane-held', '--owner=lane-held', '--holds=leased-machines');
    await expect(run('release', '--id=lane-held')).rejects.toThrow(/--hold=<label> is required for 'release'/);
    await expect(run('release', '--id=nobody', '--hold=leased-machines')).rejects.toThrow(/no such estate: nobody/);
    expect((await new EstateRegistry(home).get('lane-held'))!.holds).toEqual(['leased-machines']);
  });

  test('a register with no --holds writes a row that holds nothing', async () => {
    await run('register', '--id=lane-plain', '--owner=lane-plain');
    expect((await new EstateRegistry(home).get('lane-plain'))!.holds).toEqual([]);
  });
});
