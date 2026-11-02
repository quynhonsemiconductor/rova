/*
 * Vietnamese edition, chapter 07-loi-theo-doi-team (US-119). Converted from the BA's static page
 * `public/guide/07-loi-theo-doi-team.html`.
 */
import { GuideShot } from '../../ui/guide-shot'
import {
  Callout,
  ChapterEyebrow,
  ChapterIntro,
  ChapterSummary,
  CheckUnderstanding,
  InstructionList,
  Lead,
  Section,
  TroubleshootList,
} from '../../ui/parts'

export default function Chapter() {
  return (
    <>
      <ChapterIntro id="chapter-07">
        <div>
          <ChapterEyebrow>PHẦN 07 · LỖI VÀ THEO DÕI TEAM</ChapterEyebrow>
          <h2>Ghi nhận lỗi và nhìn tiến độ của cả Team</h2>
          <Lead>
            <strong>Quality {'>'} Defects</strong> tập trung toàn bộ Defect của phạm vi đang chọn.{' '}
            <strong>Track {'>'} Team Status</strong> nhóm các Task theo người phụ trách để người
            quản lý nhìn khối lượng và tiến độ của Team trong một Iteration.
          </Lead>
        </div>
        <ChapterSummary aria-label="Sau phần này bạn sẽ làm được">
          <strong>Sau phần này, bạn sẽ làm được</strong>
          <ul>
            <li>Mở và đọc danh sách Defect trong Quality.</li>
            <li>Tạo Defect từ màn hình Quality.</li>
            <li>Phân biệt Severity, Priority, State và Flow State.</li>
            <li>Đọc Team Status theo Iteration và Owner.</li>
            <li>Kiểm tra quan hệ giữa Task và tiến độ Work Item cha.</li>
          </ul>
        </ChapterSummary>
      </ChapterIntro>
      <Section
        id="mo-quality-defect"
        number="07.1"
        title="Mở Quality Defects"
        lead="Dùng màn hình này khi cần xem riêng các lỗi thay vì lọc Defect trong Backlog."
      >
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Kiểm tra Project và Team</strong>
              <p>
                Defect hiển thị theo phạm vi đang chọn trên thanh đầu trang. Chọn đúng Project và
                Team trước khi đọc số liệu hoặc tạo mới.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Mở Quality {'>'} Defects</strong>
              <p>
                Màn hình có vùng tổng quan và danh sách Defect. Khi phạm vi chưa có lỗi, hệ thống
                hiển thị <b>No defects logged yet</b>; đây không phải lỗi tải dữ liệu.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Đọc các cột chính</strong>
              <p>
                Danh sách gồm Rank, ID, Name, User Story, Severity, Priority, State, Flow State,
                Fixed In Build, Iteration, Submitted By và Owner.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Tìm và thu hẹp kết quả</strong>
              <p>
                Dùng Search defects, Filters và Show Fields. Phân trang ở cuối bảng chỉ thay đổi số
                dòng đang xem.
              </p>
            </div>
          </li>
        </InstructionList>
        <p>
          Defect trong Quality và Defect trong Backlog là <strong>cùng một Work Item</strong>. Thay
          đổi ở một màn hình phải được phản ánh ở màn hình còn lại; không tạo bản sao chỉ để theo
          dõi trong Quality.
        </p>
      </Section>
      <Section
        id="tao-defect-quality"
        number="07.2"
        title="Tạo Defect từ Quality"
        lead="Dùng Add New khi phát hiện lỗi và muốn ghi nhận trực tiếp trong màn hình chuyên trách."
      >
        <GuideShot
          name="03-quality-defects-production"
          alt="Form Add New Defect với Title, Description, Severity, Priority, Found In, Root Cause, Assignee, Release và User Story."
          caption="Form Add New tại Quality > Defects và các trường mô tả lỗi."
        />
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Chọn Add New</strong>
              <p>
                Form tạo nhanh mở ngay trên danh sách Quality. Kiểm tra lại phạm vi ở thanh đầu
                trang trước khi nhập.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Nhập Title và Description</strong>
              <p>
                Title nêu ngắn gọn biểu hiện lỗi. Description nên ghi điều kiện, các bước tái hiện,
                kết quả mong đợi và kết quả thực tế.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Chọn mức độ và người xử lý</strong>
              <p>
                Chọn Severity, Priority, Assignee và các thông tin liên quan nếu đã biết. Có thể để
                trống trường chưa xác định và bổ sung sau.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Liên kết User Story nếu phù hợp</strong>
              <p>
                User Story là tùy chọn. Chỉ liên kết Story đang hoạt động trong cùng Project; không
                chọn một Story chỉ vì tên gần giống.
              </p>
            </div>
          </li>
          <li>
            <span>5</span>
            <div>
              <strong>Chọn Add New để lưu</strong>
              <p>
                Sau khi tạo, mở Defect Detail để kiểm tra State, Flow State, Team, Iteration và các
                trường cần bổ sung.
              </p>
            </div>
          </li>
        </InstructionList>
        <p>
          <strong>Kết quả mong đợi:</strong> Defect mới xuất hiện trong Quality và Backlog với cùng
          ID. Nếu cần tạo chi tiết hơn ngay từ đầu, bạn cũng có thể tạo Defect từ Backlog theo hướng
          dẫn ở Phần 03.
        </p>
      </Section>
      <Section
        id="phan-loai-defect"
        number="07.3"
        title="Phân loại Defect để xử lý đúng thứ tự"
        lead="Mỗi trường trả lời một câu hỏi khác nhau. Không dùng Priority thay cho Severity."
      >
        <p>
          <strong>Severity</strong> mô tả mức độ ảnh hưởng của lỗi đến sản phẩm: None, Critical,
          Major Problem, Minor Problem hoặc Trivial. Chọn theo hậu quả thực tế, ví dụ mất dữ liệu
          hoặc chặn luồng chính nghiêm trọng hơn một lỗi hiển thị nhỏ.
        </p>
        <p>
          <strong>Priority</strong> mô tả thứ tự cần xử lý: None, Urgent, High, Normal hoặc Low. Một
          lỗi Severity cao có thể chưa phải ưu tiên đầu tiên nếu chưa ảnh hưởng phạm vi đang giao;
          quyết định Priority cần dựa trên kế hoạch và rủi ro hiện tại.
        </p>
        <p>
          <strong>User Story</strong> cho biết lỗi liên quan trực tiếp đến nhu cầu nào. Liên kết này
          không bắt buộc và chỉ nhận Story trong cùng Project. <strong>Fixed In Build</strong> là
          thông tin nhập tay về build hoặc phiên bản có bản sửa; chỉ điền khi đã xác định được build
          đó.
        </p>
        <Callout>
          <strong>Owner vẫn phụ thuộc phạm vi Team</strong>
          <p>
            Người có quyền tạo Defect không mặc nhiên xuất hiện trong danh sách Owner. Danh sách tên
            vẫn tuân theo Project, Team và membership giống User Story.
          </p>
        </Callout>
      </Section>
      <Section
        id="vong-doi-defect"
        number="07.4"
        title="Cập nhật vòng đời Defect"
        lead="Defect có State riêng để theo dõi quá trình xử lý lỗi, đồng thời vẫn có Flow State của Work Item."
      >
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Submitted</strong>
              <p>Lỗi vừa được ghi nhận và đang chờ xem xét.</p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Open</strong>
              <p>Lỗi đã được chấp nhận để phân tích hoặc xử lý.</p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Fixed</strong>
              <p>Bản sửa đã có và đang chờ xác nhận kết quả.</p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Closed</strong>
              <p>Bản sửa đã được xác nhận và lỗi được đóng.</p>
            </div>
          </li>
          <li>
            <span>5</span>
            <div>
              <strong>Closed Declined</strong>
              <p>Dùng khi quyết định không xử lý lỗi và cần giữ lại bản ghi cùng lý do.</p>
            </div>
          </li>
        </InstructionList>
        <p>
          <strong>Flow State</strong> dùng các giá trị Idea, Defined, In-Progress, Completed,
          Accepted và Release. Flow State phục vụ luồng công việc; Defect State phục vụ vòng đời
          lỗi. Hai trường độc lập nên đổi Flow State không tự đổi Defect State.
        </p>
        <p>
          Closed và Closed Declined dùng khi cần giữ Defect làm lịch sử. Xóa Defect là thao tác
          khác, cần đúng quyền và bước xác nhận. Hướng dẫn này không yêu cầu mở lại Defect đã Closed
          hoặc Closed Declined vì quy tắc reopen chưa nằm trong phạm vi đã xác nhận.
        </p>
      </Section>
      <Section
        id="doc-team-status"
        number="07.5"
        title="Đọc Team Status theo Iteration"
        lead="Dùng Track > Team Status để xem Task được phân cho từng thành viên và tổng số giờ trong một Iteration."
      >
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Chọn đúng Team</strong>
              <p>
                Team Status lấy thành viên từ Team đang chọn. All Teams là phạm vi xem tổng hợp,
                không phải một Team để giao Task.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Mở Track {'>'} Team Status</strong>
              <p>
                Màn hình chỉ dành cho Workspace Admin và Project Admin theo quyền hiện tại. Editor
                quản lý Task từ tab Tasks của Work Item và không vào Team Status.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Chọn Iteration</strong>
              <p>
                Dùng nút trước, danh sách Iteration và nút sau ở đầu trang. Đổi Iteration sẽ thay
                toàn bộ nhóm thành viên, Task và số tổng.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Đọc dòng Totals</strong>
              <p>
                Totals cộng Capacity, Estimate, To Do và Actuals của toàn bộ phạm vi Iteration,
                không chỉ các dòng trên trang phân trang hiện tại.
              </p>
            </div>
          </li>
          <li>
            <span>5</span>
            <div>
              <strong>Mở nhóm thành viên</strong>
              <p>
                Mỗi nhóm hiển thị tên, số Task, phần trăm tiến độ và số giờ. Mở nhóm để xem Task ID,
                Task Name, Work Product, Release, State và Owner.
              </p>
            </div>
          </li>
        </InstructionList>
        <p>
          Team Status có <strong>Filters</strong> và phân trang; không có ô Search Tasks hoặc Show
          Fields riêng. Task không có Owner được nhóm dưới <strong>Unassigned</strong> với Capacity
          bằng 0 giờ.
        </p>
      </Section>
      <Section
        id="kiem-tra-rollup"
        number="07.6"
        title="Kiểm tra tiến độ Work Item cha"
        lead="Team Status hiển thị Task, còn tiến độ tổng hợp được phản ánh về User Story hoặc Defect cha."
      >
        <p>
          Mỗi Task trong Team Status thuộc đúng một User Story hoặc Defect được ghi ở cột{' '}
          <strong>Work Product</strong>. Task kế thừa Iteration từ Work Item cha và được tính đúng
          một lần trong phạm vi đã chọn.
        </p>
        <p>
          Khi một Task chuyển sang Completed, hệ thống cập nhật lại tiến độ của Work Item cha. Nếu
          vẫn còn Task chưa Completed, item cha chưa tự Completed. Khi tất cả Task con đã Completed,
          item cha tự chuyển sang Completed.
        </p>
        <p>
          Nếu mở lại một Task về Defined hoặc In-Progress, item cha tự chuyển về In-Progress và tính
          lại tiến độ. Estimate, To Do và Actual của Task vẫn giữ nguyên; đổi State không tự sửa các
          trường giờ.
        </p>
        <CheckUnderstanding>
          <strong>Kiểm tra nhanh khi số liệu chưa khớp</strong>
          <ul>
            <li>Task có nằm dưới đúng US/DE và đúng Iteration không?</li>
            <li>Task có Owner thuộc Team đang chọn hay đang ở Unassigned?</li>
            <li>Có Task con nào chưa Completed không?</li>
            <li>Estimate, To Do và Actual đã được cập nhật riêng chưa?</li>
          </ul>
        </CheckUnderstanding>
      </Section>
      <Section
        id="xu-ly-chat-luong-team"
        number="07.7"
        title="Xử lý tình huống thường gặp"
        lead="Kiểm tra phạm vi và nguồn dữ liệu trước khi tạo lại Defect hoặc Task."
      >
        <TroubleshootList>
          <article>
            <span>01</span>
            <div>
              <strong>Quality không có Defect</strong>
              <p>
                Kiểm tra Project, Team, Search và Filters. Nếu màn hình báo No defects logged yet
                sau khi bỏ lọc, phạm vi hiện tại chưa có Defect.
              </p>
            </div>
          </article>
          <article>
            <span>02</span>
            <div>
              <strong>Defect có trong Backlog nhưng không thấy ở Quality</strong>
              <p>
                Đối chiếu cùng Project/Team và bỏ bộ lọc. Hai màn hình dùng cùng dữ liệu Defect nên
                không tạo item thay thế.
              </p>
            </div>
          </article>
          <article>
            <span>03</span>
            <div>
              <strong>Không chọn được User Story</strong>
              <p>
                Story phải đang hoạt động, cùng Project và nằm trong phạm vi bạn được truy cập. Có
                thể để trống liên kết nếu lỗi không thuộc một Story cụ thể.
              </p>
            </div>
          </article>
          <article>
            <span>05</span>
            <div>
              <strong>Không mở được Team Status</strong>
              <p>
                Editor không có quyền vào màn hình này. Dùng tab Tasks của Work Item hoặc liên hệ
                Project Admin khi cần xem tổng hợp Team.
              </p>
            </div>
          </article>
          <article>
            <span>06</span>
            <div>
              <strong>Không thấy thành viên trong Team Status</strong>
              <p>
                Danh sách chỉ lấy active member của Team đang chọn. Người ngoài Team không được tạo
                thành một nhóm thành viên mới.
              </p>
            </div>
          </article>
          <article>
            <span>07</span>
            <div>
              <strong>Tổng giờ không đổi khi đổi State</strong>
              <p>
                Đây là hành vi đúng. Cập nhật Estimate, To Do và Actual trực tiếp trên Task; State
                chỉ phản ánh giai đoạn thực hiện.
              </p>
            </div>
          </article>
        </TroubleshootList>
      </Section>
    </>
  )
}
