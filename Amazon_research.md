
Amazon AGI Labs

    Blog
    Careers
    Podcast

Machine learning
What makes browser use hard for AI Agents?
By Amazon AGI
October 6, 2025
nova-computer-use-agi-lab.png

For many of us, the act of clicking a button or typing into a text field on a website is simplicity itself. For AI agents, these interactions are anything but simple, requiring a careful orchestration of events that make seemingly straightforward browser use surprisingly complex. Each website presents its own quirks, including unique behaviors, loading patterns, and security mechanisms. An AI agent must learn to navigate uncertainty, whether that means waiting for a page to finish loading, retrying an action, or deferring to a user when it encounters a login prompt or captcha. Training an agent to use the browser isn’t about teaching it fixed rules, it’s about teaching it to adapt to the loosely held conventions frontend developers follow when building the web.

    Reliability isn’t just a technical requirement, it’s the foundation of trust between human and machine.

At Amazon’s AGI Lab, our team is tackling this challenge by breaking down browser interactions into their most fundamental building blocks. Through this work, we’ve found that reliability, the guarantee that an action will execute correctly every time, is the cornerstone of effective browser automation.

In practice, that means the model must not only perform the exact action it’s asked, flawlessly and consistently, but also avoid doing anything beyond what it’s instructed. Imagine working with an application you could only rely on half the time, and when it erred, it did something completely unexpected. That’s not an application you’d utilize.

But why is reliability so hard for agents at these minimum atomic units of interaction? Shouldn’t asking AI to click on something be simple?

The hidden complexity of browser interactions

If you squint at what a browser-use agent is supposed to do, the process looks linear: take a user prompt, break it down into a plan, and then execute that plan. Execution means first identifying the right features, say, the “blue button to the left of the title” and then correctly clicking that button. The problem we kept running into was that each step in that process might succeed only a certain percentage of the time. Multiply those probabilities together across an entire task, and the result is a system that, in practice, doesn’t work at all.

Multiplication of uncertainties is the killer of reliability, and in enterprise environments, reliability is the whole point. So when our end-to-end approach wasn’t getting us there, we decided to break the problem down further by focusing on two core pieces: perception (identifying elements from natural language) and actuation (synthetically interacting with a website). Together, these pieces make up the execution elements of what a browser-use agent is supposed to do.

To support this, we built a domain-specific language that let users script the browser, much like writing JavaScript. With functions like click('blue button'), users could compose scripts that combined into complex workflows. This meant we could spend dedicated cycles focusing on improving reliability for browser perception and actuation. But to understand this problem more deeply, we had to dive into what it means to interact with elements on the web.

When we click a button, say, the compose email icon, the browser isn’t performing a single “click” action. Instead, it triggers a sequence of events — hover, pointer move, mouse down, mouse up, the click itself — that together create the illusion of a simple action.

A frontend developer can choose to make their site respond to any of these events and might even expect them to fire in a specific order. When a browser-use agent tries to click a button, it must reproduce the entire chain of events, in the correct sequence, to both accurately mimic how a human interacts with the compose button and ensure the button behaves as expected. That led us to the next problem: How do we begin to identify events that need to fire and understand the correct order?

From hacky solutions to reliable architecture

When we first started out, we weren’t sure what kind of architecture would resonate best with developers. We originally believed that the winning product would be an actuation solution that could be baked into any browser and not need special permissions or infrastructure to run. Over time, we revisited that initial assumption and ultimately opted to align to open-source standards.

Our journey took us through three distinct phases:

    The naive approach. Initially, we simply found the elements and called basic browser methods like `element.click()`. This worked often but sometimes failed because modern web frameworks expect a sequence of events, not just a single function call.
    The deep dive. We then rebuilt our system to replicate exactly what browsers do during human interaction. Instead of triggering one event, we triggered all the events that a real browser expects during user interaction, including mouse movement, hover states, focus changes, and more, with most of the required parameters set. We also took the time to handle shadow DOMs and recursive message bussing through iframes. This significantly improved reliability but also required extensive maintenance. On top of that, it still wouldn’t work in all circumstances, and there were select edge cases that we just couldn’t solve.
    The standardized solution. Eventually, to ensure a more sustainable approach, we migrated to Playwright, an open-source browser automation framework. That required reworking our infrastructure, including new server components and adding support for remote hosted browsers. The result was greater reliability and reduced maintenance for our team via offloading some low-level implementation details to an open-source toolset. Additionally, incorporating a lot of the structure from version 2 along with the battle-tested knowledge we gained along the way meant we didn’t have to start from scratch.

The incredible diversity of websites also meant we were often caught in a game of whack-a-mole, trying to manually handle every edge case, only to have new ones pop up. Open source gave us an opportunity to offload a lot of this burden by tapping into the developer community for support. The sheer volume of contributors meant greater surface coverage for unseen or unexpected scenarios, allowing us to focus on increasing reliability.

This reliability challenge isn’t just a nice-to-have-metric, it’s the minimum threshold for agentic AI systems to truly be useful to people and companies alike. The consequences of failure in an enterprise setting can be incredibly steep.

In our work with enterprise clients, we've improved browser automation to achieve 90%+ reliability in early enterprise use cases. This might seem minor, but it's the difference between a useful tool and an expensive liability. In the world of consumer applications, people might have a lower threshold for reliability because if an agent gets you partway to your answer, it’s an improvement from having to do it all yourself. But in enterprise environments where an automated workflow might run 10,000 times every day, even a small failure rate could mean big customer impact.

The human element: Trust and observation

One of our most surprising discoveries came when deploying at a logistics company: even though we automated tasks to save time, employees found the process distracting. After clicking “run in the background”, they carefully watched the automation window, partly fascinated by the mouse moving on its own, but mostly worried it might make a mistake.

Although our evaluations showed the agent was accurate, this “observation behavior” blocked real productivity gains. To fix it, we removed animations, replaced the display with a black window, and ran 20–30 parallel sessions in the background. We also had the agent return results in an easy-to-parse format so users could quickly verify outcomes themselves.

This shift unlocked real value: employees finished work much faster and gained trust in the system. The lesson was clear: Automation challenges aren’t only technical, they’re also human. Effective systems must both work and earn trust while integrating seamlessly into existing workflows.

Now, with a reliable execution framework in place, we’re revisiting the planning problem. By focusing on the smallest atomic units of browser interaction and building reliability from the ground up across each and every element, we’re creating automation systems that can truly transform workflows. In a world increasingly powered by AI, reliably manipulating the browser isn’t just a technical feat, it’s the foundation for AI teammates that can navigate the web as effectively as humans.
Research areas

    Machine learning

About the Author
Amazon AGI

    Blog
    Careers

Amazon AGI Labs
AmazonScience-black-171x29.svg
