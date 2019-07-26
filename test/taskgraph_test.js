const {TaskGraph, Lock} = require('../src/taskgraph');
const assume = require('assume');
const assert = require('assert');
const {Readable} = require('stream');
const Observable = require('zen-observable');

const delayTask = ({delay, failWith, result, ...task}) => {
  task.run = async (requirements, provide) => {
    await new Promise(resolve => setTimeout(resolve, delay));
    if (failWith) {
      throw new Error(failWith);
    }
    if (result) {
      return result;
    }
    const res = {};
    for (const k of task.provides) {
      res[k] = true;
    }
    return res;
  };
  return task;
};

class FakeRenderer {
  constructor() {
    this.updates = [];
  }

  start(nodes) {
    this.updates.push('start');
  }

  stop(nodes) {
    this.updates.push('stop');
  }

  update(node, change, value) {
    if (change === 'status' || change === 'step') {
      value = JSON.stringify(value);
    }
    this.updates.push(`${change} ${value} ${node.task.title}`);
  }
}

suite('src/taskgraph.js', function() {
  suite('TaskGraph', function() {
    // delays here serve to order the execution of parallel tasks
    const nodes = [
      delayTask({title: 'D1', requires: [], provides: ['1'], delay: 1}),
      delayTask({title: 'D2', requires: ['1'], provides: ['2', '3'], delay: 1}),
      delayTask({title: 'D3', requires: ['1'], provides: ['4', '5'], delay: 10}),
      delayTask({title: 'D4', requires: ['3', '4'], provides: ['6'], delay: 1}),
      delayTask({title: 'D5', requires: ['4', '6'], provides: ['7'], delay: 1}),
    ];

    test('executes a graph', async function() {
      const renderer = new FakeRenderer();
      const graph = new TaskGraph(nodes, {renderer});
      await graph.run();
      assume(renderer.updates).to.deeply.equal([
        'start',
        'state running D1',
        'state finished D1',
        'state running D2',
        'state running D3',
        'state finished D2',
        'state finished D3',
        'state running D4',
        'state finished D4',
        'state running D5',
        'state finished D5',
        'stop',
      ]);
    });

    suite('_target', function() {
      test('with a target with no requirements', function() {
        const graph = new TaskGraph(nodes, {target: '1'});
        assume(graph.nodes.map(n => n.task.title)).to.deeply.equal(['D1']);
      });

      test('with a target that a node provides among others', function() {
        const graph = new TaskGraph(nodes, {target: '3'});
        assume(graph.nodes.map(n => n.task.title)).to.deeply.equal(['D1', 'D2']);
      });

      test('with a target that a node provides among others', function() {
        const graph = new TaskGraph(nodes, {target: '3'});
        assume(graph.nodes.map(n => n.task.title)).to.deeply.equal(['D1', 'D2']);
      });

      test('with an array of targets', function() {
        const graph = new TaskGraph(nodes, {target: ['3', '4']});
        assume(graph.nodes.map(n => n.task.title)).to.deeply.equal(['D1', 'D2', 'D3']);
      });
    });

    test('executes a subgraph with targeting', async function() {
      const renderer = new FakeRenderer();
      const graph = new TaskGraph(nodes, {renderer, target: '6'});
      await graph.run();
      assume(renderer.updates).to.deeply.equal([
        'start',
        'state running D1',
        'state finished D1',
        'state running D2',
        'state running D3',
        'state finished D2',
        'state finished D3',
        'state running D4',
        'state finished D4',
        'stop',
      ]);
    });

    test('seralizes with locks', async function() {
      const renderer = new FakeRenderer();
      const nodes = [
        delayTask({title: 'S1', requires: [], provides: ['1'], delay: 2}),
        delayTask({title: 'S2', requires: [], provides: ['2'], delay: 4}),
        delayTask({title: 'LA', requires: [], provides: [], locks: ['qbit'], delay: 5}),
        delayTask({title: 'LB', requires: ['1'], provides: [], locks: ['qbit'], delay: 5}),
        delayTask({title: 'LC', requires: ['2'], provides: [], locks: ['qbit'], delay: 5}),
      ];
      const graph = new TaskGraph(nodes, {
        renderer,
        locks: {
          qbit: new Lock(2),
        },
      });
      await graph.run();
      assume(renderer.updates).to.deeply.equal([
        'start',
        'state running S1',
        'state running S2',
        'state running LA', // starts immediately, takes 1 slot from lock
        'state finished S1',
        'state running LB', // starts immediately when S1 is done, takes 2nd slot
        'state finished S2',
        'state finished LA',
        'state running LC', // starts when LA releases a slot
        'state finished LB',
        'state finished LC',
        'stop',
      ]);
    });

    test('renders failures', async function() {
      const renderer = new FakeRenderer();
      const graph = new TaskGraph([{
        title: 'FAIL',
        run: async (requirements) => {
          throw new Error('uhoh');
        },
      }], {renderer});
      await assume(graph.run()).to.throwAsync();
      assume(renderer.updates).to.deeply.equal([
        'start',
        'state running FAIL',
        'state failed FAIL',
        'fail Error: uhoh FAIL',
        'stop',
      ]);
    });

    test('completes running tasks before throwing a failure', async function() {
      const renderer = new FakeRenderer();
      const graph = new TaskGraph([
        delayTask({title: 'F1', failWith: 'uhoh 1', requires: [], provides: [], delay: 2}),
        delayTask({title: 'F2', failWith: 'uhoh 2', requires: [], provides: [], delay: 3}),
        delayTask({title: 'OK', requires: [], provides: [], delay: 4}),
        delayTask({title: 'F3', failWith: 'uhoh 3', requires: [], provides: [], delay: 5}),
      ], {renderer});
      try {
        await graph.run();
        assert(false, 'expected an error');
      } catch (err) {
        assume(err).to.match(/uhoh 1/); // first error is thrown..
      }
      assume(renderer.updates).to.deeply.equal([
        'start',
        'state running F1',
        'state running F2',
        'state running OK',
        'state running F3',
        'state failed F1',
        'fail Error: uhoh 1 F1',
        'state failed F2',
        'fail Error: uhoh 2 F2',
        'state finished OK',
        'state failed F3',
        'fail Error: uhoh 3 F3',
        'stop',
      ]);
    });

    test('succeeds if a task provides nothing', async function() {
      const renderer = new FakeRenderer();
      const graph = new TaskGraph([
        delayTask({title: 'OK', requires: [], provides: [], result: null, delay: 0}),
      ], {renderer});
      await graph.run();
      assume(renderer.updates).to.deeply.equal([
        'start',
        'state running OK',
        'state finished OK',
        'stop',
      ]);
    });

    test('succeeds if a task provides one thing and returns nothing', async function() {
      const renderer = new FakeRenderer();
      const graph = new TaskGraph([
        delayTask({title: 'OK', requires: [], provides: ['a'], result: null, delay: 0}),
      ], {renderer});
      const context = await graph.run();
      assume(context).to.deeply.equal({a: true});
      assume(renderer.updates).to.deeply.equal([
        'start',
        'state running OK',
        'state finished OK',
        'stop',
      ]);
    });

    test('fails if a task does not return all provides keys', async function() {
      const renderer = new FakeRenderer();
      const graph = new TaskGraph([
        delayTask({title: 'OK', requires: [], provides: ['a', 'b'], result: {a: 10}, delay: 0}),
      ], {renderer});
      try {
        await graph.run();
        assert(false, 'expected an error');
      } catch (err) {
        assume(err).to.match(/did not provide expected/); // first error is thrown..
      }
      assume(renderer.updates).to.deeply.equal([
        'start',
        'state running OK',
        'state failed OK',
        'fail AssertionError [ERR_ASSERTION]: Task OK did not provide expected b OK',
        'stop',
      ]);
    });

    suite('utils.skip', function() {
      test('skips', async function() {
        const renderer = new FakeRenderer();
        const nodes = [{
          title: 'SKIP',
          requires: [],
          provides: ['a', 'b'],
          run: async (requirements, {skip}) => {
            return skip({provides: {a: 10, b: 20}});
          },
        }];
        const graph = new TaskGraph(nodes, {renderer});
        const context = await graph.run();
        assume(context).to.deeply.equal({a: 10, b: 20});
        assume(renderer.updates).to.deeply.equal([
          'start',
          'state running SKIP',
          'state skipped SKIP',
          'skip skipped SKIP',
          'stop',
        ]);
      });

      test('skips with a reason', async function() {
        const renderer = new FakeRenderer();
        const nodes = [{
          title: 'SKIP',
          requires: [],
          provides: [],
          run: async (requirements, {skip}) => {
            return skip({reason: 'because'});
          },
        }];
        const graph = new TaskGraph(nodes, {renderer});
        const context = await graph.run();
        assume(renderer.updates).to.deeply.equal([
          'start',
          'state running SKIP',
          'state skipped SKIP',
          'skip because SKIP',
          'stop',
        ]);
      });
    });

    suite('utils.step', function() {
      test('records a step update', async function() {
        const renderer = new FakeRenderer();
        const nodes = [{
          title: 'STEP',
          requires: [],
          provides: [],
          run: async (requirements, {step}) => {
            step({title: 'Step 1'});
            step({title: 'Step 2'});
          },
        }];
        const graph = new TaskGraph(nodes, {renderer});
        const context = await graph.run();
        assume(renderer.updates).to.deeply.equal([
          'start',
          'state running STEP',
          'step {"title":"Step 1"} STEP',
          'step {"title":"Step 2"} STEP',
          'state finished STEP',
          'stop',
        ]);
      });
    });

    suite('utils.status', function() {
      test('updates status', async function() {
        const renderer = new FakeRenderer();
        const nodes = [{
          title: 'STAT',
          requires: [],
          provides: [],
          run: async (requirements, {status}) => {
            status({message: 'hi'});
            status({progress: 50});
            status({progress: 100});
            status({message: 'bye'});
          },
        }];
        const graph = new TaskGraph(nodes, {renderer});
        const context = await graph.run();
        assume(renderer.updates).to.deeply.equal([
          'start',
          'state running STAT',
          'status {"message":"hi"} STAT',
          'status {"progress":50} STAT',
          'status {"progress":100} STAT',
          'status {"message":"bye"} STAT',
          'state finished STAT',
          'stop',
        ]);
      });
    });

    suite('utils.waitFor', function() {
      test('handles streams', async function() {
        const renderer = new FakeRenderer();
        const nodes = [{
          title: 'STR',
          requires: [],
          provides: [],
          run: async (requirements, {waitFor}) => {
            const s = new Readable();
            s.push(new Buffer('some da'));
            s.push(new Buffer('ta\nand another line\n'));
            s.push(new Buffer('third'));
            s.push(new Buffer(' line'));
            s.push(null);
            await waitFor(s);
          },
        }];
        const graph = new TaskGraph(nodes, {renderer});
        await graph.run();
        assume(renderer.updates).to.deeply.equal([
          'start',
          'state running STR',
          'log some data STR',
          'log and another line STR',
          'log third line STR',
          'state finished STR',
          'stop',
        ]);
      });

      test('handles observables', async function() {
        const renderer = new FakeRenderer();
        const nodes = [{
          title: 'OBS',
          requires: [],
          provides: [],
          run: async (requirements, {waitFor}) => {
            await waitFor(new Observable(observer => {
              setTimeout(() => observer.next('data 1'), 5);
              setTimeout(() => observer.next('data 2'), 10);
              setTimeout(() => observer.complete(), 15);
            }));
          },
        }];
        const graph = new TaskGraph(nodes, {renderer});
        await graph.run();
        assume(renderer.updates).to.deeply.equal([
          'start',
          'state running OBS',
          'log data 1 OBS',
          'log data 2 OBS',
          'state finished OBS',
          'stop',
        ]);
      });
    });
  });
});
