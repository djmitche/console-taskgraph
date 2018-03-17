const _ = require('lodash');
const assert = require('assert');
const format = require('date-fns/format');
const logUpdate = require('log-update');
const {dots2: spinner} = require('cli-spinners');
const chalk = require('chalk');
const logSymbols = require('log-symbols');
const isStream = require('is-stream');
const isPromise = require('is-promise');
const isObservable = require('is-observable');
const figures = require('figures');
const stripAnsi = require('strip-ansi');
const cliTruncate = require('cli-truncate');
const unicodeProgress = require('unicode-progress');
const Observable = require('zen-observable');

/**
 * A graph of tasks.
 *
 * Task dependencies are in the form of named values that other tasks produce, stored in a map
 * called `context`.
 *
 * The graph will only begin executing a task when its requirements are satisfied.
 *
 * Each task has the shape
 *
 * {
 *   title: "..",      // display name for the task
 *   requires: [ .. ], // keys for values required before this task starts
 *   provides: [ .. ], // keys for values this task will provide
 *   run: async (requirements, utils) => ..,
 * }
 *
 * The async `run` function for a task is given an object `requirements` containing the values
 * named in `task.requires`.  It should return an object containing the keys given in `provides`.
 * As a convenience, a task with zero or one keys in `provides` may return nothing; the result
 * is treated as a value of true for the single given key.
 *
 * The `utils` argument to the `run` function contains some useful utilities for tasks that help
 * with debugging output:
 *
 * The `utils.waitFor` function can be used to wait for various things to complete:
 *   * a Promise (OK, this isn't so useful)
 *   * a stream, the lines of which are displayed
 *   * an Observable, the data values from which are displayed
 * This is a useful way to show progress to the user while handling streams or other observables.
 *
 * The `utils.status` function updates the step's current status.  It accepts options
 *   * `message` - a short status message such as "Barring the foo"
 *   * `progress` - progress of this task (as a percentage)
 *
 * The `utils.skip` function flags the task as "skipped".  The task must still return its provided
 * values, and this function makes that easy: `return utils.skip({key: value})`.
 *
 * The `utils.step` function adds a 'step' to this task. Steps are pretty basic: the most recent step
 * is considered to be 'running' and all previous steps to be finished.  It's useful as a way of
 * indicating progress from step to step within a larger task.  Call `utils.step({title: 'Step 2'})`
 */
class TaskGraph {
  constructor(tasks, options={}) {
    tasks.forEach(task => {
      assert('title' in task, 'Task has no title');
      assert('run' in task, `Task ${task.title} has no run method`);
    });
    this.nodes = tasks.map(task => ({state: 'pending', task: {requires: [], provides: [], ...task}}));
    this.renderer = options.renderer || (process.stdout.isTTY ? new TerminalRenderer() : new LogRenderer());
  }

  /**
   * Run the graph.  This will return when all nodes in the graph are finished.
   * The optional `context` argument can be used to pre-populate some keys. It will
   * be modified in-place and returned.
   */
  async run(context={}) {
    this.renderer.start(this.nodes);
    try {
      await new Promise((resolve, reject) => {
        const refresh = () => {
          let pendingCount = 0;
          this.nodes.forEach(node => {
            if (node.state === 'pending' && node.task.requires.every(k => k in context)) {
              this._runNode(node, context, refresh).catch(reject);
            }
          });
          if (Object.values(this.nodes).every(n => n.state === 'finished' || n.state === 'skipped')) {
            resolve();
          }
        };
        refresh();
      });
    } finally {
      this.renderer.stop();
    }

    return context;
  }

  async _runNode(node, context, refresh) {
    const {task} = node;
    const utils = {};
    utils.waitFor = value => {
      if (isStream(value)) {
        value = streamToLoggingObservable(value);
      }

      if (isObservable(value)) {
        value = new Promise((resolve, reject) => {
          value.subscribe({
            next: data => this.renderer.update(node, 'log', data),
            complete: resolve,
            error: reject,
          });
        });
      }

      if (isPromise(value)) {
        return value.then(utils.waitFor);
      }
      
      return value;
    };

    utils.skip = provided => {
      node.state = 'skipped';
      this.renderer.update(node, 'state', 'skipped');
      return provided;
    };

    utils.status = status => {
      this.renderer.update(node, 'status', status);
    };

    utils.step = ({title}) => {
      this.renderer.update(node, 'step', {title});
    };

    node.state = 'running';
    this.renderer.update(node, 'state', 'running');

    const requirements = {};
    task.requires.forEach(k => requirements[k] = context[k]);
    let result = await task.run(requirements, utils);
    // as a convenience, provide a single value as a simple 'true'
    if (!result) {
      assert(task.provides.length <= 1, `Task ${task.title} provides multiple results, but did not return any values`);
      result = task.provides.length === 1 ? {[task.provides[0]]: true} : {};
    }

    // check that the step provided what was expected
    Object.keys(result).forEach(key => {
      assert(!(key in context), `Task ${task.title} provided ${key}, but it has already been provided`);
      assert(task.provides.indexOf(key) !== -1, `Task ${task.title} provided unexpected ${key}`);
    });
    task.provides.forEach(key => {
      assert(key in result, `Task ${task.title} did not provide expected ${key}`);
    });
    Object.assign(context, result);

    if (node.state !== 'skipped') {
      node.state = 'finished';
      this.renderer.update(node, 'state', 'finished');
    }
    refresh();
  }
}

module.exports.TaskGraph = TaskGraph;

/**
 * A renderer for a TaskGraph is responsible for displaying its progress and eventual
 * status.  TerminalRenderer uses terminal output, while LogRenderer just logs events.
 *
 * Renderers get their `start` and `stop` methods called at the beginning and end of a
 * run, and in between get a series of update calls with `change`:
 *
 * - `state` -- the given node's state has changed; value is the new state
 * - `log` -- a line of log output from the step has arrived
 * - `status` -- a status update, with the options to `util.status` as value
 * - `step` -- a substep has begun; the value has {title: ..}
 */

class TerminalRenderer {
  constructor() {
    this.progressBar = unicodeProgress({width: 30});
  }

  start(nodes) {
    this.nodes = nodes;
    // nodes are only displayed when they are running or finished
    this.displayed = [];
    this.interval = setInterval(() => this.render(), spinner.interval);
  }

  stop() {
    clearInterval(this.interval);
    this.render();
  }

  update(node, change, value) {
    if (change === 'state') {
      if (value === 'running') {
        node.started = new Date().getTime();
        this.displayed.push(node);
      }
    } else if (change === 'step') {
      if (!node.steps) {
        node.steps = [];
      }
      delete node.output;
      delete node.message;
      delete node.progress;
      node.steps.push(value);
    } else if (change === 'log') {
      if (!node.output) {
        node.output = [];
      }
      node.output.push(value.toString().trimRight());
      node.output = node.output.slice(-4);
    } else if (change == 'status') {
      if (value.message) {
        node.message = value.message;
      }
      if (value.progress !== undefined) {
        node.progress = value.progress;
      }
    }
  }

  render() {
    const now = new Date().getTime();
    const logoutput = this.displayed.map(node => {
      let noderep = [];

      if (node.state === 'running') {
        const frameidx = Math.trunc((now - node.started) / spinner.interval) % spinner.frames.length;
        const frame = chalk.yellow(spinner.frames[frameidx]);
        noderep.push(`${frame} ${chalk.bold(node.task.title)}`);

        // show previous and current steps
        if (node.steps) {
          const last = node.steps.length - 1;
          node.steps.forEach((step, i) => {
            const title = chalk.bold(cliTruncate(step.title, process.stdout.columns - 4));
            noderep.push(` ${i === last ? frame : logSymbols.success} ${title}`);
          });
        }

        // render the node output, if any
        if (node.output) {
          const lines = node.output.map(line => {
            const logged = stripAnsi(cliTruncate(line, process.stdout.columns - 4));
            return ` ${chalk.cyan(figures.arrowRight)} ${logged}`;
          });
          noderep.push(`${lines.join('\n')}`);
        }

        // build a status line..
        let statusline = [];
        if ('progress' in node) {
          statusline.push(chalk.magenta.bgBlue(this.progressBar(node.progress)));
        }
        if (node.message) {
          let width = process.stdout.columns - 4;
          if ('progress' in node) {
            width -= 31;
          }
          statusline.push(`${chalk.bold(cliTruncate(node.message, width))}`);
        }
        if (statusline.length) {
          noderep.push(` ${chalk.cyan(figures.info)} ` + statusline.join(' '));
        }

      } else if (node.state === 'skipped') {
        noderep.push(`${logSymbols.info} ${chalk.bold(node.task.title)} (skipped)`);
      } else {
        noderep.push(`${logSymbols.success} ${chalk.bold(node.task.title)}`);
      }

      return noderep.join('\n');
    });

    const numFinished = this.displayed.filter(n => n.state != 'running').length;
    const pctFinished = Math.trunc(100 * numFinished / Object.keys(this.nodes).length);
    const progress = chalk.cyanBright(`${pctFinished}% finished`);
    logoutput.push(progress);

    logUpdate(logoutput.join('\n'));
  }
}

class LogRenderer {
  start(nodes) {
  }

  stop() {
  }

  update(node, change, value) {
    let output;
    if (change === 'state') {
      output = `${node.task.title}: ${value}`;
    } else if (change === 'log') {
      output = `${node.task.title}: ${value}`;
    } else if (change === 'step') {
      output = `${node.task.title}: start step ${value.title}`;
    } else if (change === 'status') {
      if (value.message) {
        output = `${node.task.title}: ${value.message}`;
      }
      // (silently ignore progress updates)
    }

    if (output) {
      const timestamp = format(new Date(), 'HH:mm:ss');
      console.log(`[${timestamp}] ${output}`);
    }
  }
}

/**
 * Convert a textual byte stream to an observable that calls next() for each
 * line, with newlines stripped.
 *
 * Object streams are handled by converting each object into a string.
 */
const streamToLoggingObservable = stream => {
  return new Observable(observer => {
    let buffer = Buffer.alloc(0);
    const onData = data => {
      if (!Buffer.isBuffer(data)) {
        data = Buffer.from(data.toString() + '\n');
      }
      buffer = Buffer.concat([buffer, data]);
      let i;
      while ((i = buffer.indexOf(0x0a)) !== -1) {
        observer.next(buffer.slice(0, i).toString());
        buffer = buffer.slice(i + 1);
      }
    };
    const onError = err => {
      cleanup();
      observer.error(err);
    };
    const onEnd = res => {
      if (buffer.length > 0) {
        observer.next(buffer.toString());
      }
      cleanup();
      observer.complete(res);
    };
    const cleanup = () => {
      try {
        stream.removeListener('data', onData);
      } catch (err) {}
      try {
        stream.removeListener('error', onError);
      } catch (err) {}
      try {
        stream.removeListener('end', onEnd);
      } catch (err) {}
    };
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onError);
  });
};
