# FundVault - Fund Management System

A full-stack fund management application built with Django REST Framework and Next.js for managing financial records, ledger entries, and fund accounts with an intuitive web interface.

## 📋 Features

- **User Authentication**: Secure user registration and login with JWT token-based authentication
- **Fund Management**: Create and manage multiple fund accounts
- **Ledger Management**: Track financial transactions with detailed ledger entries
- **User Accounts**: Manage user profiles and account information
- **REST API**: Comprehensive REST API for all operations
- **Responsive UI**: Modern, responsive web interface built with Next.js and React
- **Data Export**: Export financial data to PDF reports
- **Charts & Visualization**: Visual representation of fund data using Chart.js
- **CORS Support**: Secure cross-origin requests

## 🏗️ Project Structure

```
Fund Management System/
├── backend/                 # Django REST API
│   ├── apps/
│   │   ├── accounts/       # User authentication and profiles
│   │   ├── common/         # Common utilities and models
│   │   └── ledger/         # Ledger and fund management
│   ├── fundvault_backend/  # Django project settings
│   ├── manage.py           # Django management script
│   └── requirements.txt    # Python dependencies
├── frontend/               # Next.js web application
│   ├── src/
│   │   ├── app/           # Next.js pages and layout
│   │   ├── components/    # Reusable React components
│   │   └── lib/           # Utility functions and helpers
│   └── package.json       # Node.js dependencies
├── data/                   # Database storage
│   └── fundvault.db       # SQLite database
└── legacy/                # Legacy code (archived)
```

## 🛠️ Tech Stack

### Backend
- **Framework**: Django 5.2.1
- **API**: Django REST Framework 3.15.2
- **Authentication**: JWT (PyJWT 2.9.0)
- **Security**: bcrypt 4.2.0
- **CORS**: django-cors-headers 4.6.0
- **Database**: SQLite

### Frontend
- **Framework**: Next.js 16.2.6
- **UI Library**: React 19.2.6
- **Charts**: Chart.js 4.5.1
- **PDF Export**: jsPDF 4.2.1
- **Styling**: CSS

## 🚀 Getting Started

### Prerequisites
- Python 3.8 or higher
- Node.js 16 or higher
- npm or yarn

### Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd "Fund Management System"
   ```

2. **Install all dependencies**
   ```bash
   npm run install:all
   ```
   
   This will:
   - Install root-level Node.js dependencies
   - Install frontend dependencies
   - Install Python backend dependencies

3. **Alternative: Manual Installation**
   
   **Backend:**
   ```bash
   python -m pip install -r backend/requirements.txt
   ```
   
   **Frontend:**
   ```bash
   npm --prefix frontend install
   ```

### Running the Application

#### Development Mode (Recommended)
Run both backend and frontend concurrently:
```bash
npm run dev
```

This will start:
- Backend API: `http://127.0.0.1:8000`
- Frontend: `http://localhost:3001`

#### Individual Development Servers

**Backend only:**
```bash
npm run dev:backend
```

**Frontend only:**
```bash
npm run dev:frontend
```

#### Production Build
```bash
npm run build
```

This will build the frontend and verify the backend configuration.

### Verify Backend Setup
```bash
npm run check:backend
```

## 📚 API Endpoints

The backend provides REST API endpoints for:
- **Users**: Registration, login, profile management
- **Funds**: Create, read, update, delete fund accounts
- **Ledger**: Record transactions and view ledger entries
- **Authentication**: JWT token generation and validation

Base URL: `http://127.0.0.1:8000/api/`

## 🗄️ Database

The application uses SQLite for data persistence. The database file is stored at:
```
data/fundvault.db
```

Database is automatically created when the Django backend runs for the first time.

## 📝 Available Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start both backend and frontend in development mode |
| `npm run dev:backend` | Start Django development server |
| `npm run dev:frontend` | Start Next.js development server |
| `npm run check:backend` | Verify Django configuration |
| `npm run build:frontend` | Build the Next.js application |
| `npm run build` | Build entire project |
| `npm run install:all` | Install all dependencies |

## 🔐 Security Features

- **JWT Authentication**: Token-based authentication for secure API access
- **Password Hashing**: bcrypt for secure password storage
- **CORS Headers**: Controlled cross-origin requests
- **User Authorization**: Role-based access control

## 📄 Frontend Pages

- **Home**: Dashboard and overview
- **Accounts**: User account management
- **Ledger**: Transaction ledger and record management
- **Reports**: Generate and export financial reports

## 🧪 Testing

To test the login functionality:
```powershell
.\test_login.ps1
```

## 🐛 Troubleshooting

### Port Already in Use
If port 8000 or 3001 is already in use, the application will fail to start.
- Change the port in the respective npm script or manage.py command
- Or kill the process using the port

### Database Issues
If you encounter database errors:
1. Delete `data/fundvault.db`
2. Run migrations: `python backend/manage.py migrate`
3. Restart the development server

### Dependencies Issues
If you have dependency conflicts:
1. Clear npm cache: `npm cache clean --force`
2. Delete `node_modules` and, if you are doing a full reinstall, both `package-lock.json` files (`package-lock.json` at the root and `frontend/package-lock.json`)
3. Reinstall: `npm run install:all`

Note: this repo intentionally keeps one lockfile at the root for workspace tooling and one inside `frontend/` for the Next.js app. The frontend is pinned to its own folder in `frontend/next.config.js`, so Next.js will not treat the root lockfile as the app root.

## 📦 Deployment

For production deployment:
1. Set `DEBUG = False` in `backend/fundvault_backend/settings.py`
2. Configure a production database (PostgreSQL recommended)
3. Use a production WSGI server (Gunicorn, uWSGI)
4. Build the frontend: `npm run build:frontend`
5. Serve static files appropriately

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 👥 Authors

- **Arachno-Sapien - Syed Junaid K**

## 📧 Contact & Support

For issues and questions, please create an issue in the repository.

---

**Happy coding! 🚀**
