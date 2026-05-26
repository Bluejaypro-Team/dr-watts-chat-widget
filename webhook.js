require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { Octokit } = require('@octokit/rest');
const { generateText, tool } = require('ai');
const { google } = require('@ai-sdk/google');
const { Pool } = require('pg');
const z = require('zod');

const app = express();
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// 1. Verify GitHub Webhook Signature
const verifySignature = (req) => {
  const signature = req.headers['x-hub-signature-256'];
  if (!signature) return false;
  
  const hmac = crypto.createHmac('sha256', process.env.WEBHOOK_SECRET);
  const digest = 'sha256=' + hmac.update(req.rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
};

// 2. Database Tools for Gemini
const getServicePricing = async (serviceName) => {
  const res = await pool.query('SELECT base_price, hourly_rate FROM service_pricing WHERE service_name ILIKE $1', [`%${serviceName}%`]);
  return res.rows[0] || { error: "Service not found." };
};

const calculateQuote = async (serviceName, hours, email) => {
  const serviceRes = await pool.query('SELECT id, base_price, hourly_rate FROM service_pricing WHERE service_name ILIKE $1', [`%${serviceName}%`]);
  if (!serviceRes.rows.length) return { error: "Unknown service." };
  
  const service = serviceRes.rows[0];
  const total = Number(service.base_price) + (Number(service.hourly_rate) * hours);
  await pool.query('INSERT INTO quotes (customer_email, service_id, estimated_hours, total_price) VALUES ($1, $2, $3, $4)', [email, service.id, hours, total]);
  return { total, message: "Quote saved successfully." };
};

// 3. Webhook Endpoint
app.post('/webhook', async (req, res) => {
  if (!verifySignature(req)) {
    return res.status(401).send('Invalid signature');
  }

  const event = req.headers['x-github-event'];
  const payload = req.body;

  // We only care about new issues and issue comments with the title containing "Dr. Watts"
  const isTargetIssue = payload.issue && payload.issue.title.includes('Dr. Watts Chat');
  if (!isTargetIssue || (event !== 'issues' && event !== 'issue_comment')) {
    return res.status(200).send('Event ignored');
  }

  // Handle only newly opened issues or new comments from humans (ignore bot comments)
  if (payload.action !== 'opened' && payload.action !== 'created') return res.status(200).end();
  if (payload.sender.type === 'Bot') return res.status(200).end();

  const userMessage = event === 'issues' ? payload.issue.body : payload.comment.body;
  const issueNumber = payload.issue.number;
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;

  res.status(202).send('Accepted'); // Acknowledge webhook quickly

  try {
    // A. Run LLM with tools
    const { text } = await generateText({
      model: google('gemini-3.5-flash'),
      prompt: `A user has said: "${userMessage}". Respond to them as Dr. Watts AI Assistant. Use your service pricing and quote calculator tools when relevant. Ask for name and email before calculating a quote.`,
      tools: {
        get_service_pricing: tool({
          description: 'Get base pricing for an electrical service.',
          parameters: z.object({ serviceName: z.string() }),
          execute: async ({ serviceName }) => await getServicePricing(serviceName)
        }),
        calculate_quote: tool({
          description: 'Calculate and save quote.',
          parameters: z.object({ serviceName: z.string(), hours: z.number(), email: z.string() }),
          execute: async ({ serviceName, hours, email }) => await calculateQuote(serviceName, hours, email)
        })
      }
    });

    // B. Post response comment to GitHub Issue
    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body: `⚡ **Dr. Watts AI:**\n\n${text}`
    });

    // C. Update README.md with the latest conversation step
    await updateReadme(owner, repo, payload.sender.login, userMessage, text);

  } catch (error) {
    console.error('Failed to process webhook:', error);
  }
});

// 4. Update README.md on GitHub
const updateReadme = async (owner, repo, user, userMsg, botMsg) => {
  // Fetch README.md content
  const { data: fileData } = await octokit.repos.getContent({ owner, repo, path: 'README.md' });
  const content = Buffer.from(fileData.content, 'base64').toString('utf8');
  
  // Format the new conversation block
  const newTranscript = `
### Conversation with @${user}
* **Human:** ${userMsg}
* **Dr. Watts AI:** ${botMsg}
  `.trim();

  // Replace content between tags
  const regex = /(<!-- CHAT_START -->)([\s\S]*?)(<!-- CHAT_END -->)/g;
  const updatedContent = content.replace(regex, `$1\n${newTranscript}\n$3`);

  // Commit the file back to the repository
  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: 'README.md',
    message: `🤖 Update chat history with @${user}`,
    content: Buffer.from(updatedContent).toString('base64'),
    sha: fileData.sha
  });
};

app.listen(3000, () => console.log('Webhook server running on port 3000'));
